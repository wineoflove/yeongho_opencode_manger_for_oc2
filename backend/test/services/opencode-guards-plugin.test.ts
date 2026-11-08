import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGuardsPluginSource } from '../../src/services/opencode-guards-plugin'
import {
  getGuardsSwitchFile,
  getGuardsVerifyOutputDir,
  getOpenCodePluginDir,
  installManagedPlugins,
} from '../../src/services/opencode/plugin-registry'
import { loadGeneratedPlugin, type GeneratedPlugin, type ToolResult } from '../helpers/opencode-plugin-context'
import { resolveOpenCode2Binary, runOpenCodeStandalone } from '../helpers/opencode-binary'

const marker = 'Retrieve original: hash=abcdef0123456789'
const longBody = 'passed\n'.repeat(1000)

type ShellResult = ToolResult & {
  output?: { output: string; exit?: number; truncated: boolean }
  content?: Array<{ type: string; text?: string }> | string
}

function shellResult(body: string, exit = 0): ShellResult {
  const content: Array<{ type: string; text?: string }> = [{ type: 'text', text: body }]
  if (exit !== 0) content.push({ type: 'text', text: `Exited with code ${exit}` })
  return { output: { output: body, exit, truncated: false }, content, metadata: { status: 'completed', truncated: false, exit } }
}

describe('ocm.guards plugin', () => {
  let root: string
  let configHome: string
  let verifyOutputDir: string
  let switchFile: string
  let plugin: GeneratedPlugin

  async function load(): Promise<GeneratedPlugin> {
    return loadGeneratedPlugin(join(getOpenCodePluginDir(configHome), 'ocm-guards.js'), { location: { directory: root } })
  }

  function before(tool: string, input: unknown, id = 'call_test') {
    return plugin.triggerToolExecuteBefore({ tool, sessionID: 'ses_test', id, input })
  }

  async function runShell(command: unknown, result: ShellResult, tool = 'shell') {
    const input = { command }
    await before(tool, input)
    await plugin.triggerToolExecuteAfter({ tool, sessionID: 'ses_test', id: 'call_test', input, status: 'completed', result })
    return result
  }

  function text(result: ShellResult): string {
    return Array.isArray(result.content) ? (result.content[0]?.text ?? '') : String(result.content ?? '')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocm-guards-'))
    configHome = join(root, 'config')
    verifyOutputDir = getGuardsVerifyOutputDir(configHome)
    switchFile = getGuardsSwitchFile(configHome)
    await installManagedPlugins(configHome)
    plugin = await load()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('default-exports the V2 plugin definition with the configured id', async () => {
    expect(plugin.id).toBe('ocm.guards')
    expect(buildGuardsPluginSource({ id: 'custom.guards', verifyOutputDir: '/v', switchFile: '/s' })).toContain('id: "custom.guards"')
  })

  it('stores verification logs beside the OpenCode state of the workspace', () => {
    expect(verifyOutputDir).toBe(join(root, '.opencode', 'state', 'opencode', 'tool-output', 'ocm-verify'))
    expect(switchFile).toBe(join(configHome, 'opencode', 'ocm-guards.json'))
  })

  it.each([
    ['write', { content: marker }],
    ['edit', { newString: marker }],
    ['patch', { patchText: marker }],
    ...['PUT', 'PATCH', 'POST'].map((method) => ['ocm', { action: 'request', params: { method, body: { value: marker } } }] as const),
    ['write', { content: 'Retrieve more: hash=123456abcdef' }],
    ['write', { content: '<<ccr:abcdef>>' }],
  ] satisfies readonly (readonly [string, Record<string, unknown>])[])('rejects compressed %s writes (%j)', async (tool, input) => {
    await expect(before(tool, input)).rejects.toThrow('OCM_GUARD_G1_COMPRESSED_CONTENT')
  })

  it.each([
    ['write', { content: 'Retrieve original: hash=... Retrieve more: hash=not-hex' }],
    ['read', { content: marker }],
    ['ocm', { action: 'request', params: { method: 'GET', body: marker } }],
    ['ocm', { action: 'send_notification', params: { method: 'POST', body: marker } }],
    ['write', { content: null }],
    ['ocm', { action: 'request', params: null }],
    ['write', null],
  ] satisfies readonly (readonly [string, unknown])[])('allows nonmarker or malformed %s input (%j)', async (tool, input) => {
    await expect(before(tool, input)).resolves.toBeUndefined()
  })

  it.each(['require("fs")', 'await import ("fs")'])('rejects unsupported browser code %s', async (code) => {
    await expect(before('playwright_browser_run_code_unsafe', { code })).rejects.toThrow('OCM_GUARD_G3_RUN_CODE_UNSUPPORTED')
  })

  it.each(['await page.title()', null])('allows supported or malformed browser code %j', async (code) => {
    await expect(before('playwright_browser_run_code_unsafe', { code })).resolves.toBeUndefined()
  })

  it('removes a screenshot filename outside the workspace and explains it in the result', async () => {
    const input: Record<string, unknown> = { filename: `${root}-sibling/shot.png` }
    await before('playwright_browser_take_screenshot', input)
    expect(input).toEqual({})

    const result: ShellResult = { content: [{ type: 'image' }], metadata: { keep: true } }
    await plugin.triggerToolExecuteAfter({
      tool: 'playwright_browser_take_screenshot',
      sessionID: 'ses_test',
      id: 'call_test',
      input,
      status: 'completed',
      result,
    })

    expect(result.metadata).toEqual({
      keep: true,
      ocmGuard: { id: 'G3', action: 'filename_removed', original: `${root}-sibling/shot.png` },
    })
    expect(Array.isArray(result.content) && result.content[1]?.text).toContain('[OCM_GUARD_G3]')

    const next: ShellResult = { content: [{ type: 'text', text: 'next' }] }
    await plugin.triggerToolExecuteAfter({
      tool: 'playwright_browser_take_screenshot',
      sessionID: 'ses_test',
      id: 'call_test',
      input: {},
      status: 'completed',
      result: next,
    })
    expect(next).toEqual({ content: [{ type: 'text', text: 'next' }] })
  })

  it.each(['relative.png', 'inside'])('keeps allowed screenshot filename %s', async (filename) => {
    const input = { filename: filename === 'inside' ? join(root, 'shot.png') : filename }
    const original = { ...input }
    await before('playwright_browser_take_screenshot', input)
    expect(input).toEqual(original)
  })

  it.each([
    'pnpm --dir backend test',
    'pnpm --filter frontend exec vitest run src/a.test.tsx',
    'bun --no-env-file test learning-review/record.test.mjs',
    'cd /x && pnpm typecheck',
    'npx tsc --noEmit',
    'node --test scripts/check.test.mjs',
    'pnpm -C /a/backend exec vitest run test/x.test.ts',
    'export A="x;y"; cd "/a && b" && env CI="true" pnpm --dir "a b" test',
    'export A="x && y" && CI=1 env /usr/bin/pnpm test',
    'CI="a b" pnpm test',
    'bunx biome check .',
    'pytest',
    'playwright test',
    'cargo clippy',
    'go vet',
    'npm run test:vitest',
    'yarn build',
  ])('summarizes verification command %s', async (command) => {
    const result = await runShell(command, shellResult(longBody))
    expect(result.metadata?.ocmGuard).toMatchObject({ id: 'G4', originalChars: longBody.length })
    expect(text(result).length).toBeLessThanOrEqual(2500)
    expect(text(result)).toContain('[OCM_GUARD_G4]')
  })

  it.each(['git status', 'rg vitest src', 'cat test.log', 'echo pnpm test', 'echo "cd /x && pnpm test"', null])(
    'preserves misleading nonverification output for %j',
    async (command) => {
      const result = shellResult(longBody, 1)
      const expected = structuredClone(result)
      await runShell(command, result)
      expect(result).toEqual(expected)
    },
  )

  it('preserves output of tools other than shell', async () => {
    const result = shellResult(longBody)
    const expected = structuredClone(result)
    await runShell('pnpm test', result, 'read')
    expect(result).toEqual(expected)
  })

  it('preserves output at or below the summary threshold', async () => {
    const result = shellResult('a'.repeat(6000))
    const expected = structuredClone(result)
    await runShell('pnpm test', result)
    expect(result).toEqual(expected)
  })

  it('leaves failed tool calls unchanged', async () => {
    const input = { command: 'pnpm test' }
    const event = { tool: 'shell', sessionID: 'ses_test', id: 'call_test', input, status: 'error' as const, error: { message: 'boom' } }
    await plugin.triggerToolExecuteAfter(event)
    expect(event).toEqual({ tool: 'shell', sessionID: 'ses_test', id: 'call_test', input, status: 'error', error: { message: 'boom' } })
  })

  it('stores the full original privately and keeps the exit notice and structured output', async () => {
    const result = await runShell('pnpm test', shellResult(longBody, 1))
    const savedPath = join(verifyOutputDir, 'ses_test_call_test.log')

    expect(await readFile(savedPath, 'utf8')).toBe(longBody)
    expect((await stat(savedPath)).mode & 0o777).toBe(0o600)
    expect(Array.isArray(result.content) && result.content.map((item) => item.text?.slice(0, 16))).toEqual([
      '[OCM_GUARD_G4] V',
      'Exited with code',
    ])
    expect(text(result)).toContain('exit: 1')
    expect(result.output).toEqual({ output: longBody, exit: 1, truncated: false })
    expect(result.metadata).toEqual({
      status: 'completed',
      truncated: false,
      exit: 1,
      ocmGuard: { id: 'G4', originalChars: longBody.length, savedPath },
    })
  })

  it('names the untruncated output when OpenCode cut the shell output', async () => {
    const truncated = `${longBody}\n\n[showing lines 990-1509 of 1509; full output saved to /state/opencode/shell/abc/sh_1.out]`
    const result = await runShell('pnpm test', shellResult(truncated, 0))
    const lines = text(result).split('\n')

    expect(lines[0]).toContain('[OCM_GUARD_G4] Verification output summarized')
    expect(lines[1]).toBe('OpenCode kept lines 990-1509 of 1509; untruncated output: /state/opencode/shell/abc/sh_1.out')
  })

  it('adds no truncation line when OpenCode kept the whole output', async () => {
    const result = await runShell('pnpm test', shellResult(longBody, 0))
    expect(text(result)).not.toContain('untruncated output')
  })

  it('summarizes string content when the shell result has no structured output', async () => {
    const result: ShellResult = { content: longBody }
    await runShell('pnpm test', result)
    expect(text(result)).toContain('[OCM_GUARD_G4]')
  })

  it('leaves the result unchanged when the original cannot be saved', async () => {
    await mkdir(join(root, '.opencode', 'state', 'opencode', 'tool-output'), { recursive: true })
    await writeFile(verifyOutputDir, 'not a directory')
    const result = shellResult(longBody, 1)
    const expected = structuredClone(result)
    await runShell('pnpm test', result)
    expect(result).toEqual(expected)
  })

  it('caps summaries with many distinct long failures and keeps the last lines', async () => {
    const body = [
      ...Array.from({ length: 60 }, (_, index) => `error ${index} ${'x'.repeat(300)}`),
      ...Array.from({ length: 30 }, (_, index) => `${index} ${'y'.repeat(300)}`),
    ].join('\n')
    const result = await runShell('pnpm test', shellResult(body))
    expect(text(result).length).toBeLessThanOrEqual(2500)
    expect(text(result)).toContain(`29 ${'y'.repeat(117)}`)
  })

  it('deduplicates failure lines and keeps last nonempty lines', async () => {
    const result = await runShell('pnpm test', shellResult(`${'error duplicate\n'.repeat(500)}\nlast\n\n`))
    const failures = text(result).split('--- last 15 lines ---')[0]
    expect(failures?.match(/error duplicate/g)).toHaveLength(1)
    expect(text(result).endsWith('last')).toBe(true)
  })

  it.each(['{', 'null', '{"disabled":"G1"}', '{"disabled":["G1",42]}'])('keeps guards enabled for malformed switch %s', async (switches) => {
    await mkdir(join(configHome, 'opencode'), { recursive: true })
    await writeFile(switchFile, switches)
    await expect(before('write', { content: marker })).rejects.toThrow('OCM_GUARD_G1')
  })

  it('refreshes stale switches only after thirty seconds', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
    await writeFile(switchFile, JSON.stringify({ disabled: ['G1', 'G3', 'G4'] }))
    await expect(before('write', { content: marker })).resolves.toBeUndefined()
    await expect(before('playwright_browser_run_code_unsafe', { code: 'require("fs")' })).resolves.toBeUndefined()
    const unsummarized = shellResult(longBody)
    const expected = structuredClone(unsummarized)
    expect(await runShell('pnpm test', unsummarized)).toEqual(expected)

    await writeFile(switchFile, '{}')
    clock.mockReturnValue(129999)
    await expect(before('write', { content: marker })).resolves.toBeUndefined()
    clock.mockReturnValue(130000)
    await expect(before('write', { content: marker })).rejects.toThrow('OCM_GUARD_G1')
  })

  it('removes only expired regular logs in its own directory at setup', async () => {
    await mkdir(verifyOutputDir, { recursive: true })
    const old = new Date(Date.now() - 8 * 86400000)
    for (const name of ['expired.log', 'recent.log', 'keep.txt']) {
      await writeFile(join(verifyOutputDir, name), name)
      if (name !== 'recent.log') await utimes(join(verifyOutputDir, name), old, old)
    }
    const outside = join(root, 'outside.log')
    await writeFile(outside, 'outside')
    await utimes(outside, old, old)
    await symlink(outside, join(verifyOutputDir, 'link.log'))
    await mkdir(join(verifyOutputDir, 'directory.log'))

    await load()

    expect((await readdir(verifyOutputDir)).sort()).toEqual(['directory.log', 'keep.txt', 'link.log', 'recent.log'])
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })
})

type ChatMessage = { role?: string; content?: unknown }
type ChatRequest = { messages?: ChatMessage[]; tools?: unknown[] }

/** Serves a scripted model that calls each tool in turn and records the tool results it receives. */
function startScriptedModel(calls: Array<{ name: string; args: Record<string, unknown> }>, toolResults: string[]) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as ChatRequest
      const toolMessages = (parsed.messages ?? []).filter((message) => message.role === 'tool')
      toolResults.splice(0, toolResults.length, ...toolMessages.map((message) => String(message.content ?? '')))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const write = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      const base = { id: 'chatcmpl-guards', object: 'chat.completion.chunk', created: 1, model: 'mock-model' }
      const next = Array.isArray(parsed.tools) && parsed.tools.length > 0 ? calls[toolMessages.length] : undefined
      if (next) {
        const toolCall = { index: 0, id: `call_${toolMessages.length + 1}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }
        write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: null }] })
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'FINAL' }, finish_reason: null }] })
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

describe.skipIf(resolveOpenCode2Binary() === null)('ocm.guards plugin against the shipped OpenCode 2 binary', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocm-guards-e2e-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a compressed write before it runs and summarizes long verification output for the model', async () => {
    const configHome = join(root, 'config')
    const workDir = join(root, 'work')
    await mkdir(join(configHome, 'opencode'), { recursive: true })
    await mkdir(workDir, { recursive: true })
    const lines = Array.from({ length: 150 }, (_, index) => `console.log('line ${index} ${'x'.repeat(60)}')`)
    await writeFile(join(workDir, 'long.test.mjs'), `import { test } from 'node:test'\ntest('long', () => {\n${lines.join('\n')}\n})\n`)

    const toolResults: string[] = []
    const model = await startScriptedModel(
      [
        { name: 'write', args: { path: join(workDir, 'out.txt'), content: marker } },
        { name: 'shell', args: { command: 'node --test long.test.mjs', description: 'Run the long test' } },
      ],
      toolResults,
    )
    await writeFile(
      join(configHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        providers: {
          mock: {
            package: '@opencode/ai/providers/openai-compatible',
            name: 'Mock',
            settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'mock-key' },
            models: { 'mock-model': { name: 'Mock Model' } },
          },
        },
        model: 'mock/mock-model',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      }),
    )
    await installManagedPlugins(configHome)

    try {
      const result = await runOpenCodeStandalone({
        cwd: workDir,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: join(root, 'cache'),
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          PWD: workDir,
          OCM_SANDBOX_ENFORCED: 'false',
        },
        message: 'run the checks',
      })

      expect(result.status).toBe(0)
      expect(toolResults).toHaveLength(2)
      expect(toolResults[0]).toContain('OCM_GUARD_G1_COMPRESSED_CONTENT')
      await expect(stat(join(workDir, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(toolResults[1]).toContain('[OCM_GUARD_G4] Verification output summarized')
      expect(toolResults[1]!.length).toBeLessThanOrEqual(2600)
      const logs = await readdir(getGuardsVerifyOutputDir(configHome))
      expect(logs).toHaveLength(1)
      const saved = await readFile(join(getGuardsVerifyOutputDir(configHome), logs[0]!), 'utf8')
      expect(saved).toContain('line 149')
      expect(saved.length).toBeGreaterThan(6000)
    } finally {
      model.server.close()
    }
  }, 120000)

  it('keeps the full original reachable when OpenCode 2 truncates shell output above its own limit', async () => {
    const configHome = join(root, 'config')
    const workDir = join(root, 'work')
    await mkdir(join(configHome, 'opencode'), { recursive: true })
    await mkdir(workDir, { recursive: true })
    const lines = Array.from({ length: 1500 }, (_, index) => `console.log('row ${index} ${'y'.repeat(90)}')`)
    await writeFile(join(workDir, 'huge.test.mjs'), `import { test } from 'node:test'\ntest('huge', () => {\n${lines.join('\n')}\n})\n`)

    const toolResults: string[] = []
    const model = await startScriptedModel(
      [{ name: 'shell', args: { command: 'node --test huge.test.mjs', description: 'Run the huge test' } }],
      toolResults,
    )
    await writeFile(
      join(configHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        providers: {
          mock: {
            package: '@opencode/ai/providers/openai-compatible',
            name: 'Mock',
            settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'mock-key' },
            models: { 'mock-model': { name: 'Mock Model' } },
          },
        },
        model: 'mock/mock-model',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      }),
    )
    await installManagedPlugins(configHome)

    try {
      const result = await runOpenCodeStandalone({
        cwd: workDir,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: join(root, 'cache'),
          OPENCODE_DISABLE_MODELS_FETCH: '1',
          PWD: workDir,
          OCM_SANDBOX_ENFORCED: 'false',
        },
        message: 'run the checks',
      })
      expect(result.status).toBe(0)
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0]).toContain('[OCM_GUARD_G4] Verification output summarized')
      const logs = await readdir(getGuardsVerifyOutputDir(configHome))
      expect(logs).toHaveLength(1)
      const saved = await readFile(join(getGuardsVerifyOutputDir(configHome), logs[0]!), 'utf8')
      expect(saved).toContain('row 1499 ')
      expect(saved).not.toContain('row 0 ')
      const pointer = /full output saved to (\S+\.out)\]/.exec(saved)
      expect(pointer).not.toBeNull()
      expect(toolResults[0]).toContain(pointer![1]!)
      const full = await readFile(pointer![1]!, 'utf8')
      expect(full).toContain('row 0 ')
      expect(full).toContain('row 1499 ')
      expect(full.length).toBeGreaterThan(saved.length)
    } finally {
      model.server.close()
    }
  }, 120000)
})
