import { describe, expect, it } from 'vitest'
import { WorkflowStatsResponseSchema } from '@opencode-manager/shared/schemas'
import { computeWorkflowStats, getBashFamily, stripBashPrefixes } from '../../src/services/stats/workflow-metrics'
import { prepareWorkflowToolPart } from '../../src/services/stats/workflow-classifiers'
import type {
  WorkflowMetricsInput,
  WorkflowToolPart,
  PreparedWorkflowToolPart,
} from '../../src/services/stats/workflow-types'

const part = (overrides: Partial<WorkflowToolPart> = {}): PreparedWorkflowToolPart =>
  prepareWorkflowToolPart({
    id: 'part',
    sessionId: 'root',
    messageId: 'message',
    time: 110,
    tool: 'bash',
    status: 'completed',
    error: null,
    inputHead: '{}',
    inputLength: 2,
    command: 'git status',
    filePath: null,
    exit: 0,
    outputTail: null,
    metaOutputTail: null,
    timedOut: false,
    guardId: null,
    ...overrides,
  })
const input = (overrides: Partial<WorkflowMetricsInput> = {}): WorkflowMetricsInput => ({
  range: '24h',
  window: { from: 100, to: 200 },
  previousWindow: { from: 0, to: 100 },
  tools: [],
  steps: [],
  messages: [],
  readPaths: [],
  sessions: [{ id: 'root', parentId: null, title: 'Root', timeCreated: 100 }],
  ...overrides,
})

describe('workflow metrics', () => {
  it('keeps full input identity while retaining only a detached preview', () => {
    const prefix = 'x'.repeat(140)
    const tools = [`${prefix}a`, `${prefix}b`, '\ud800', '\ud801'].flatMap((inputHead) =>
      Array.from({ length: 3 }, () => part({ inputHead })),
    )
    const result = computeWorkflowStats(input({ tools }))
    expect(result.totals.current).toMatchObject({ repeatedGroups: 4, repeatedCalls: 12 })
    expect(result.repeats.map((row) => row.inputPreview)).toEqual([prefix, prefix, '\ud800', '\ud801'])
    expect(Object.keys(tools[0] ?? {})).not.toEqual(expect.arrayContaining(['inputHead']))
  })

  it('preserves null and empty input equivalence without merging different input lengths', () => {
    const tools = [null, '', null].map((inputHead) => part({ inputHead, inputLength: null }))
    const result = computeWorkflowStats(input({ tools: [...tools, part({ inputHead: '', inputLength: 0 })] }))
    expect(result.totals.current).toMatchObject({ repeatedGroups: 1, repeatedCalls: 3 })
    expect(result.repeats[0]?.inputPreview).toBe('')
  })

  it('returns zero or null totals when input is empty', () => {
    const fixture = input({ sessions: [] })
    const result = computeWorkflowStats(fixture)
    expect(Object.values(result.totals.current).every((value) => value === 0 || value === null)).toBe(true)
    expect(result.totals.previous).toEqual(result.totals.current)
    expect(result.tools).toEqual([])
    expect(result.firstCall).toEqual([])
    expect(
      WorkflowStatsResponseSchema.safeParse({
        ...result,
        generatedAt: 200,
        window: fixture.window,
        previousWindow: fixture.previousWindow,
        mcpStatusSource: null,
      }).success,
    ).toBe(true)
  })

  it.each([
    ['export A="a;b"; /usr/bin/curl x', 'curl'],
    ['export A="a && b" && pnpm test', 'npm/pnpm'],
    ['cd "/tmp/a && b" && node app', 'node'],
    ['A="a b" env B=x /usr/bin/git status', 'git'],
    ['env cd "/tmp/a" && export A=x; B=y env npm test', 'npm/pnpm'],
    ['"/usr/bin/bun" test', 'bun'],
    ['echo curl', 'other'],
  ])('classifies the executable when command is %s', (command, family) => {
    const result = getBashFamily(command)
    expect(result).toBe(family)
  })

  it('preserves quoted arguments when stripping verification prefixes', () => {
    const command = 'export A="x; y"; cd "/a b" && env X=y pnpm test "a && b"'
    const result = stripBashPrefixes(command)
    expect(result).toEqual(['pnpm', 'test', 'a && b'])
  })

  it.each([
    { error: 'shell tool terminated command after exceeding timeout' },
    { outputTail: 'COMMAND TIMED OUT' },
    { metaOutputTail: 'execution timed out' },
    { error: 'command failed because it timed out' },
    { timedOut: true },
    { exit: 124 },
    { command: 'env curl example.com', exit: 28 },
  ])('counts timeouts when the signal is %j', (overrides) => {
    const fixture = input({ tools: [part(overrides)] })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current.bashTimeouts).toBe(1)
  })

  it('counts only numeric nonzero exits and curl-specific exit 28 timeouts', () => {
    const fixture = input({ tools: [part({ exit: '124' }), part({ exit: 28 }), part({ exit: 1 })] })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({ bashCalls: 3, bashNonzero: 2, bashTimeouts: 0, statusErrors: 0 })
  })

  it('classifies all LSP errors and aggregates lowercase extensions and durations', () => {
    const errors = [
      'Timed out waiting for fresh diagnostics for /a.TS within 3000ms.',
      'LSP file path must be inside request cwd: /a.TS',
      'ENOENT /a.TS',
      'unknown failure',
    ]
    const fixture = input({
      tools: [
        ...errors.map((error) => part({ tool: 'lsp_diagnostics', status: 'error', error, filePath: '/a.TS' })),
        part({ tool: 'lsp_diagnostics', filePath: 'README' }),
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.lsp).toEqual({
      byExtension: [
        { extension: '.ts', calls: 4, errors: 4, timeout: 1, outsideCwd: 1, enoent: 1, other: 1 },
        { extension: '<none>', calls: 1, errors: 0, timeout: 0, outsideCwd: 0, enoent: 0, other: 0 },
      ],
      timeoutMs: [{ value: 3000, count: 1 }],
    })
  })

  it('normalizes signatures and sorts tied counts lexically with a top twenty limit', () => {
    const error = '  failed https://host/a?q=3 /a/b ~/home/a C:\\tmp\\x ses_ab msg_cd prt_ef call_gh abcdef1234 123  '
    const fixture = input({
      tools: [
        part({ status: 'error', error }),
        part({ tool: 'read', status: 'error', error }),
        ...Array.from({ length: 25 }, (_, index) =>
          part({ status: 'error', error: `z${String.fromCharCode(97 + index)}` }),
        ),
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.errorSignatures).toHaveLength(20)
    expect(result.errorSignatures[0]).toEqual({
      signature: 'failed <URL> <PATH> <PATH> <PATH> <ID> <ID> <ID> <ID> <ID> <N>',
      count: 2,
      tools: ['bash', 'read'],
    })
    expect(result.errorSignatures[1]?.signature).toBe('za')
  })

  it.each([
    ['{"password":"p4ss"}', 'p4ss'],
    ['{"apiKey": "abc123"}', 'abc123'],
    ['token=abc', 'abc'],
    ['Authorization: Bearer xyz', 'xyz'],
    ['--password p4ss', 'p4ss'],
    ['sk-abcdefgh1234', 'sk-abcdefgh1234'],
    ['Basic YWJjZGVmZ2g=', 'YWJjZGVmZ2g='],
    ['client-secret: hidden', 'hidden'],
  ])('redacts repeated input when it contains %s', (inputHead, secret) => {
    const fixture = input({
      tools: Array.from({ length: 3 }, () => part({ inputHead, inputLength: inputHead.length })),
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({ repeatedGroups: 1, repeatedCalls: 3 })
    expect(result.repeats[0]?.inputPreview).toContain('<REDACTED>')
    expect(result.repeats[0]?.inputPreview).not.toContain(secret)
  })

  it('separates repeat keys by session, tool and full input length with a top ten limit', () => {
    const tools = Array.from({ length: 12 }, (_, index) =>
      Array.from({ length: index + 3 }, () => part({ inputHead: `input${index}` })),
    ).flat()
    const fixture = input({
      tools: [
        ...tools,
        part({ sessionId: 'other', inputHead: 'input0' }),
        part({ tool: 'read', inputHead: 'input0' }),
        part({ inputHead: 'input0', inputLength: 3000 }),
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({ repeatedGroups: 12, repeatedCalls: 102 })
    expect(result.repeats).toHaveLength(10)
    expect(result.repeats[0]?.count).toBe(14)
  })

  it('matches reference rereads including repeated paths within the next thirty tool calls', () => {
    const fixture = input({
      messages: [
        { id: 'summary', sessionId: 'root', time: 120, role: 'assistant', summary: true, error: 'failed' },
        { id: 'summary2', sessionId: 'other', time: 120, role: 'assistant', summary: true, error: null },
      ],
      readPaths: [{ sessionId: 'root', time: 20, filePath: '/a' }],
      tools: Array.from({ length: 31 }, (_, index) =>
        part({ time: 121 + index, tool: [0, 1, 30].includes(index) ? 'read' : 'bash', filePath: '/a' }),
      ),
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({ compactions: 2, compactionErrors: 1, avgRereadsAfterCompaction: 1 })
  })

  it('uses interactive user messages as denominator and new sessions for first-call medians', () => {
    const sessions = Array.from({ length: 4 }, (_, index) => ({
      id: `s${index}`,
      parentId: null,
      title: '',
      timeCreated: 100,
    }))
    const fixture = input({
      sessions: [
        ...sessions,
        { id: 'old', parentId: null, title: '', timeCreated: 99 },
        { id: 'scheduled', parentId: 'root', title: 'Scheduled: task', timeCreated: 100 },
        { id: 'child', parentId: 'root', title: '', timeCreated: 100 },
      ],
      steps: [
        ...sessions.map((session, index) => ({
          sessionId: session.id,
          messageId: session.id,
          time: 110,
          agent: 'build',
          providerID: 'p',
          modelID: 'm',
          input: index * 10,
          cacheRead: 5,
          cacheWrite: 5,
          output: 100,
        })),
        {
          sessionId: 'old',
          messageId: 'old',
          time: 110,
          agent: 'build',
          providerID: null,
          modelID: null,
          input: 900,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
        },
      ],
      messages: ['s0', 'scheduled', 'child'].map((sessionId) => ({
        id: sessionId,
        sessionId,
        time: 110,
        role: 'user',
        summary: false,
        error: null,
      })),
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({
      userMessages: 1,
      inputContextTokens: 1000,
      tokensPerUserMessage: 1000,
    })
    expect(result.firstCall).toEqual([{ agent: 'build', sessions: 4, medianTokens: 25 }])
    expect(result.kinds.map((row) => [row.kind, row.sessions])).toEqual([
      ['interactive', 5],
      ['scheduled', 1],
      ['subagent', 1],
    ])
  })

  it('joins message agents, orders tools and counts guard errors independently of adjustments', () => {
    const fixture = input({
      tools: [
        part({ status: 'error', error: 'Error: OCM_GUARD_G1 blocked' }),
        part({ tool: 'read', status: 'error', error: 'prefix OCM_GUARD_G3 blocked', guardId: 'G3' }),
        part({ guardId: 'G4' }),
        part({ error: 'OCM_GUARD_G1', time: 99 }),
        part({ time: 200 }),
      ],
      messages: [
        { id: 'message', sessionId: 'root', time: 110, role: 'assistant', summary: false, error: null, agent: 'build' },
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.current).toMatchObject({
      toolCalls: 3,
      statusErrors: 2,
      errorRate: 0.6667,
      guardBlocked: 2,
      guardAdjusted: 2,
    })
    expect(result.totals.previous.toolCalls).toBe(1)
    expect(result.tools.map((row) => row.tool)).toEqual(['bash', 'read'])
    expect(result.agents).toEqual([{ agent: 'build', calls: 3, errors: 2, errorRate: 0.6667 }])
    expect(result.guards).toEqual([
      { id: 'G1', blocked: 1, adjusted: 0 },
      { id: 'G3', blocked: 1, adjusted: 1 },
      { id: 'G4', blocked: 0, adjusted: 1 },
    ])
  })

  it('recognizes exact MCP names and all declared prefixes but not lookalikes', () => {
    const prefixes = [
      'context7_',
      'firecrawl_',
      'playwright_',
      'ref_',
      'codegraph_',
      'lsp_',
      'websearch_',
      'grep_app_',
      'markitdown_',
      'session_',
    ]
    const fixture = input({
      tools: [
        ...prefixes.map((prefix) => part({ tool: `${prefix}action`, status: 'error' })),
        ...['skill_mcp', 'ocm', 'ocm_extra', 'skill_mcp_extra', 'xcontext7_action'].map((tool) => part({ tool })),
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.mcp).toHaveLength(12)
    expect(result.mcp.find((row) => row.prefix === 'context7_')).toEqual({
      prefix: 'context7_',
      calls: 1,
      errors: 1,
      errorRate: 1,
    })
    expect(result.agents[0]?.agent).toBe('<unknown>')
  })

  it('limits tools after sorting errors before calls when more than twenty-five tools are present', () => {
    const fixture = input({
      tools: [
        ...Array.from({ length: 26 }, (_, index) => part({ tool: `tool-${index}` })),
        ...Array.from({ length: 3 }, () => part({ tool: 'popular' })),
        part({ tool: 'failure', status: 'error' }),
      ],
    })
    const result = computeWorkflowStats(fixture)
    expect(result.tools).toHaveLength(25)
    expect(result.tools.slice(0, 2)).toEqual([
      { tool: 'failure', calls: 1, errors: 1, errorRate: 1 },
      { tool: 'popular', calls: 3, errors: 0, errorRate: 0 },
    ])
  })

  it('computes previous totals independently when calls fall on window boundaries', () => {
    const fixture = input({
      tools: [-1, 0, 1, 99, 100, 200].map((time) =>
        part({ time, status: 'error', error: 'OCM_GUARD_G1', exit: 124, guardId: 'G4' }),
      ),
    })
    const result = computeWorkflowStats(fixture)
    expect(result.totals.previous).toMatchObject({
      toolCalls: 3,
      statusErrors: 3,
      errorRate: 1,
      bashCalls: 3,
      bashNonzero: 3,
      bashTimeouts: 3,
      repeatedGroups: 1,
      repeatedCalls: 3,
      guardBlocked: 3,
      guardAdjusted: 3,
    })
    expect(result.totals.current).toMatchObject({ toolCalls: 1, repeatedGroups: 0, repeatedCalls: 0 })
  })

  it('uses the first step and message agent when computing medians for at least three new sessions', () => {
    const sessions = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      parentId: null,
      title: '',
      timeCreated: 100,
    }))
    const fixture = input({
      sessions,
      messages: sessions.map((session, index) => ({
        id: session.id,
        sessionId: session.id,
        time: 101,
        role: 'assistant',
        summary: false,
        error: null,
        agent: index < 3 ? 'joined' : 'small',
      })),
      steps: sessions.flatMap((session, index) =>
        [130, 110].map((time) => ({
          sessionId: session.id,
          messageId: session.id,
          time,
          agent: 'fallback',
          providerID: null,
          modelID: null,
          input: time === 110 ? index * 10 : 999,
          cacheRead: 0,
          cacheWrite: 0,
          output: 999,
        })),
      ),
    })
    const result = computeWorkflowStats(fixture)
    expect(result.firstCall).toEqual([{ agent: 'joined', sessions: 3, medianTokens: 10 }])
  })
})
