import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { createOpenCodeServeDirectories, resolveOpenCode2Binary, startOpenCodeServe } from '../helpers/opencode-binary'

const binary = resolveOpenCode2Binary()

describe.skipIf(binary === null)('OpenCode 2 file edit tool results', () => {
  it('records write and edit results in the shapes the session artifacts panel reads', async () => {
    const directories = await createOpenCodeServeDirectories()
    const directory = join(directories.root, 'repo')
    const calls = [
      { name: 'write', arguments: { path: 'created.txt', content: 'one\n' } },
      {
        name: 'edit',
        arguments: { path: 'created.txt', oldString: 'one', newString: 'two' },
      },
      {
        name: 'patch',
        arguments: {
          patchText:
            '*** Begin Patch\n*** Add File: added.txt\n+added\n*** Update File: existing.txt\n@@\n-old\n+new\n*** End Patch',
        },
      },
    ]
    let step = 0
    const offered: string[][] = []
    const llm = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          tools?: { function?: { name?: string } }[]
        }
        const names = (body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
        if (names.length) offered.push(names)
        while (names.length && calls[step] && !names.includes(calls[step]!.name)) step++
        const call = names.length ? calls[step] : undefined
        if (names.length) step++
        const base = {
          id: `shape-${step}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = call
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${step}`,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            }
          : { role: 'assistant', content: names.length ? 'Done.' : 'Title' }
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`,
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
    await writeFile(join(directory, 'existing.txt'), 'old\n')
    await mkdir(join(directories.configHome, 'opencode'), { recursive: true })
    await writeFile(
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
      }),
    )
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
      const session = await api.session.create({
        location: { directory },
        model: { providerID: 'mock', id: 'fixture' },
      })
      await api.session.prompt({
        sessionID: session.id,
        text: 'apply the edits',
      })
      await api.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) })
      const page = await api.message.list({
        sessionID: session.id,
        type: 'assistant',
        limit: 100,
        order: 'asc',
      })
      const tools = page.data.flatMap((message) =>
        message.type === 'assistant' ? message.content.flatMap((item) => (item.type === 'tool' ? [item] : [])) : [],
      )
      const write = tools.find((item) => item.name === 'write')
      const edit = tools.find((item) => item.name === 'edit')
      expect(offered[0]).toEqual(expect.arrayContaining(['write', 'edit']))
      expect(write?.state).toMatchObject({
        status: 'completed',
        input: { path: 'created.txt' },
        content: [{ type: 'text', text: expect.stringMatching(/^Created file successfully/) }],
      })
      expect(edit?.state).toMatchObject({
        status: 'completed',
        input: { path: 'created.txt' },
        metadata: { files: [{ file: 'created.txt', status: 'modified', additions: 1, deletions: 1 }] },
      })
      await api.session.remove({ sessionID: session.id })
    } finally {
      llm.closeAllConnections()
      llm.close()
      await server.stop()
      await rm(directories.root, { recursive: true, force: true })
    }
  }, 120000)
})
