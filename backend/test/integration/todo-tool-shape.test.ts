import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMessageInfo } from '@opencode-manager/shared/opencode'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { createOpenCodeServeDirectories, resolveOpenCode2Binary, startOpenCodeServe } from '../helpers/opencode-binary'

const binary = resolveOpenCode2Binary()

const FIRST_LIST = [
  { content: 'Read the failing test', status: 'completed' },
  { content: 'Fix the parser', status: 'in_progress' },
  { content: 'Run the suite', status: 'pending' },
]

const SECOND_LIST = [
  { content: 'Read the failing test', status: 'completed' },
  { content: 'Fix the parser', status: 'completed' },
  { content: 'Run the suite', status: 'in_progress' },
  { content: 'Drop the workaround', status: 'cancelled' },
]

type TodoSetting = 'off' | 'on' | 'enabled-after-start'

/**
 * Runs one prompt against a real OpenCode 2 server whose fake model calls todowrite twice when offered.
 * With 'enabled-after-start' the server starts without the flag, which is then written and applied
 * through the location reload that OpenCode Manager uses for configuration changes.
 */
async function runTodoSession(setting: TodoSetting): Promise<{ offered: string[]; messages: SessionMessageInfo[] }> {
  const directories = await createOpenCodeServeDirectories()
  const directory = join(directories.root, 'repo')
  const calls = [FIRST_LIST, SECOND_LIST]
  let step = 0
  const offered = new Set<string>()
  const llm = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        tools?: { function?: { name?: string } }[]
      }
      const names = (body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
      names.forEach((name) => offered.add(name))
      const todos = names.includes('todowrite') ? calls[step] : undefined
      if (todos) step++
      const base = {
        id: `todo-${step}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
      }
      const delta = todos
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${step}`,
                type: 'function',
                function: {
                  name: 'todowrite',
                  arguments: JSON.stringify({ todos }),
                },
              },
            ],
          }
        : { role: 'assistant', content: names.length ? 'Done.' : 'Title' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: todos ? 'tool_calls' : 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
  })
  const listening = once(llm, 'listening')
  llm.listen(0, '127.0.0.1')
  await listening
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('fixture unavailable')
  await mkdir(directory)
  await mkdir(join(directories.configHome, 'opencode'), { recursive: true })
  const writeConfig = (experimentalTodo: boolean) =>
    writeFile(
      join(directories.configHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        autoupdate: false,
        providers: {
          mock: {
            package: '@opencode/ai/providers/openai-compatible',
            settings: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'fixture',
            },
            models: { fixture: { name: 'Fixture' } },
          },
        },
        model: 'mock/fixture',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
        ...(experimentalTodo ? { experimental: { todo: true } } : {}),
      }),
    )
  await writeConfig(setting === 'on')
  const server = await startOpenCodeServe({
    service: true,
    directories,
    env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
  })
  try {
    const api = new FetchOpenCodeClient({
      baseUrl: server.baseUrl,
      basicAuth: buildOpenCodeBasicAuth(server.password),
      defaultDirectory: false,
    }).api
    if (setting === 'enabled-after-start') {
      await writeConfig(true)
      await api.location.reload()
    }
    const session = await api.session.create({
      location: { directory },
      model: { providerID: 'mock', id: 'fixture' },
    })
    await api.session.prompt({
      sessionID: session.id,
      text: 'plan and track the work',
    })
    await api.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) })
    const page = await api.message.list({
      sessionID: session.id,
      limit: 100,
      order: 'asc',
    })
    await api.session.remove({ sessionID: session.id })
    return { offered: [...offered], messages: page.data }
  } finally {
    llm.closeAllConnections()
    llm.close()
    await server.stop()
    await rm(directories.root, { recursive: true, force: true })
  }
}

describe.skipIf(binary === null)('OpenCode 2 experimental todo tool', () => {
  it('offers todowrite only with experimental.todo and records each list as the completed call input', async () => {
    const disabled = await runTodoSession('off')
    expect(disabled.offered).not.toContain('todowrite')

    const { offered, messages } = await runTodoSession('on')
    expect(offered).toContain('todowrite')
    const todoCalls = messages.flatMap((message) =>
      message.type === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'tool' && part.name === 'todowrite' ? [part] : []))
        : [],
    )
    expect(todoCalls).toHaveLength(2)
    expect(todoCalls[0]?.state).toMatchObject({
      status: 'completed',
      input: { todos: FIRST_LIST },
    })
    expect(todoCalls[1]?.state).toMatchObject({
      status: 'completed',
      input: { todos: SECOND_LIST },
    })
  }, 180000)

  it('offers todowrite after the flag is written and the configuration reloaded, without a restart', async () => {
    const { offered } = await runTodoSession('enabled-after-start')
    expect(offered).toContain('todowrite')
  }, 180000)
})
