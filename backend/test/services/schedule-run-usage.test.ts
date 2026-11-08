import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeApi, SessionInfo, SessionMessageAssistant } from '@opencode-manager/shared/opencode'
import { buildFailedUsage, captureScheduleRunUsage } from '../../src/services/schedule-run-usage'

const tokens = {
  input: 10,
  output: 20,
  reasoning: 3,
  cache: { read: 4, write: 5 },
}
const additional = {
  input: 100,
  output: 200,
  reasoning: 30,
  cacheRead: 40,
  cacheWrite: 50,
  cost: 9,
}
const zero = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  messages: 0,
}
function session(id: string, parentID?: string): SessionInfo {
  return {
    id,
    parentID,
    projectID: 'project',
    cost: 2,
    tokens,
    time: { created: 1, updated: 1 },
    location: { directory: '/test' },
    agent: 'latest-session-agent',
  }
}
function assistant(id: string, agent = 'first'): SessionMessageAssistant {
  return {
    id,
    type: 'assistant',
    agent,
    model: { providerID: 'provider', id: 'model' },
    time: { created: 1 },
    content: [],
    cost: 0.25,
    tokens,
  }
}
function client() {
  return {
    session: {
      get: vi.fn<OpenCodeApi['session']['get']>().mockResolvedValue(session('root')),
      list: vi.fn<OpenCodeApi['session']['list']>().mockResolvedValue({ data: [], cursor: {} }),
    },
    message: {
      list: vi.fn<OpenCodeApi['message']['list']>().mockResolvedValue({ data: [], cursor: {} }),
    },
  }
}
afterEach(() => vi.useRealTimers())

describe('captureScheduleRunUsage', () => {
  it('sums each session once, includes archived descendants, and keeps assistant and additional accounting separate', async () => {
    const api = client()
    const child = {
      ...session('child', 'root'),
      time: { created: 1, updated: 2, archived: 3 },
    }
    api.session.list.mockImplementation(async (input) => {
      expect(input).not.toHaveProperty('archived')
      expect(input).not.toHaveProperty('order')
      if (input?.parentID === 'root') {
        return input.cursor ? { data: [child], cursor: {} } : { data: [child], cursor: { next: 'children' } }
      }
      return {
        data: input?.parentID === 'child' ? [session('grandchild', 'child')] : [],
        cursor: {},
      }
    })
    api.message.list.mockImplementation(async (input) => {
      expect(input.type).toBe('assistant')
      expect(input.limit).toBe(100)
      if (input.cursor) {
        expect(input).not.toHaveProperty('order')
        return input.cursor === 'last'
          ? { data: [], cursor: {} }
          : { data: [assistant('second', 'later')], cursor: { next: 'last' } }
      }
      expect(input.order).toBe('asc')
      return input.sessionID === 'root'
        ? { data: [assistant('first')], cursor: { next: 'more' } }
        : { data: [assistant(input.sessionID, 'child-agent')], cursor: {} }
    })
    const result = await captureScheduleRunUsage(api, 'root', additional)
    expect(result).toMatchObject({
      agentUsed: 'first',
      usage: {
        sessions: 3,
        error: null,
        additional,
        totals: {
          input: 30,
          output: 60,
          reasoning: 9,
          cacheRead: 12,
          cacheWrite: 15,
          cost: 6,
          messages: 4,
        },
        byModel: {
          'provider/model': {
            input: 40,
            output: 80,
            reasoning: 12,
            cacheRead: 16,
            cacheWrite: 20,
            cost: 1,
            messages: 4,
          },
        },
      },
    })
    expect(api.session.get).toHaveBeenCalledTimes(1)
    expect(api.session.list).toHaveBeenCalledWith({ parentID: 'root', limit: 100 }, expect.anything())
    expect(api.session.list).toHaveBeenCalledWith(
      { parentID: 'root', limit: 100, cursor: 'children' },
      expect.anything(),
    )
  })

  it('counts assistant messages with absent usage and keeps model identities separate', async () => {
    const api = client()
    api.message.list.mockResolvedValue({
      data: [
        { ...assistant('one'), cost: undefined, tokens: undefined },
        { ...assistant('two'), model: { providerID: 'other', id: 'model' } },
      ],
      cursor: {},
    })
    const { usage } = await captureScheduleRunUsage(api, 'root')
    expect(usage.byModel).toEqual({
      'provider/model': { ...zero, messages: 1 },
      'other/model': {
        input: 10,
        output: 20,
        reasoning: 3,
        cacheRead: 4,
        cacheWrite: 5,
        cost: 0.25,
        messages: 1,
      },
    })
    expect(usage.totals.cost).toBe(2)
    expect(usage.totals.messages).toBe(2)
  })

  it('does not substitute a child or latest session agent for a missing root assistant', async () => {
    const api = client()
    api.session.list.mockResolvedValueOnce({
      data: [session('child', 'root')],
      cursor: {},
    })
    api.message.list.mockResolvedValueOnce({ data: [], cursor: {} }).mockResolvedValueOnce({
      data: [assistant('child-message', 'child-agent')],
      cursor: {},
    })
    expect((await captureScheduleRunUsage(api, 'root')).agentUsed).toBeNull()
  })

  it('retains actual partial totals without exposing provider errors', async () => {
    const api = client()
    api.message.list
      .mockResolvedValueOnce({
        data: [assistant('one')],
        cursor: { next: 'next' },
      })
      .mockRejectedValueOnce(new Error('secret-provider-token'))
    const { usage } = await captureScheduleRunUsage(api, 'root', additional)
    expect(usage).toMatchObject({
      sessions: 1,
      additional,
      error: 'USAGE_SNAPSHOT_FAILED',
      totals: { cost: 2, messages: 1 },
    })
    expect(JSON.stringify(usage)).not.toContain('secret-provider-token')
  })

  it('reports missing roots without counting a session', async () => {
    const api = client()
    api.session.get.mockRejectedValue({
      _tag: 'SessionNotFoundError',
      sessionID: 'root',
      message: 'secret',
    })
    const { usage } = await captureScheduleRunUsage(api, 'root')
    expect(usage).toMatchObject({
      sessions: 0,
      totals: zero,
      error: 'USAGE_SESSION_NOT_FOUND',
    })
    expect(api.message.list).not.toHaveBeenCalled()
  })

  it.each(['root-identity', 'child-identity', 'fork', 'cycle'])('rejects invalid traversal: %s', async (kind) => {
    const api = client()
    if (kind === 'root-identity') api.session.get.mockResolvedValue(session('wrong'))
    if (kind === 'child-identity')
      api.session.list.mockResolvedValueOnce({
        data: [session('fork')],
        cursor: {},
      })
    if (kind === 'fork')
      api.session.get.mockResolvedValue({
        ...session('root'),
        fork: {
          sessionID: 'source',
          boundary: { type: 'through', messageID: 'inherited' },
        },
      })
    if (kind === 'cycle') {
      api.session.list
        .mockResolvedValueOnce({
          data: [session('child', 'root')],
          cursor: {},
        })
        .mockResolvedValueOnce({
          data: [session('root', 'child')],
          cursor: {},
        })
    }
    const { usage } = await captureScheduleRunUsage(api, 'root')
    expect(usage.error).toBe(kind === 'cycle' ? null : 'USAGE_SNAPSHOT_FAILED')
    expect(usage.totals.messages).toBe(0)
    expect(usage.sessions).toBe(kind === 'root-identity' ? 0 : kind === 'cycle' ? 2 : 1)
  })

  it.each(['message', 'session'] as const)(
    'rejects empty or repeated %s cursors without double counting',
    async (kind) => {
      const api = client()
      if (kind === 'message')
        api.message.list.mockResolvedValue({
          data: [assistant('one')],
          cursor: { next: 'same' },
        })
      else
        api.session.list.mockResolvedValue({
          data: [],
          cursor: { next: 'same' },
        })
      const { usage } = await captureScheduleRunUsage(api, 'root')
      expect(usage.error).toBe('USAGE_SNAPSHOT_FAILED')
      expect(usage.totals.messages).toBe(kind === 'message' ? 1 : 0)
    },
  )

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid token counts %s without rounding',
    async (input) => {
      const api = client()
      api.session.list.mockResolvedValueOnce({
        data: [{ ...session('child', 'root'), tokens: { ...tokens, input } }],
        cursor: {},
      })
      const { usage } = await captureScheduleRunUsage(api, 'root')
      expect(usage).toMatchObject({
        sessions: 1,
        error: 'USAGE_SNAPSHOT_FAILED',
        totals: { input: 10, cost: 2 },
      })
    },
  )

  it('bounds all sessions at 100 and does not issue redundant gets', async () => {
    const api = client()
    api.session.list.mockResolvedValueOnce({
      data: Array.from({ length: 100 }, (_, index) => session(`child-${index}`, 'root')),
      cursor: {},
    })
    const { usage } = await captureScheduleRunUsage(api, 'root')
    expect(usage).toMatchObject({
      sessions: 100,
      totals: { cost: 200 },
      error: 'USAGE_SNAPSHOT_LIMIT',
    })
    expect(api.session.get).toHaveBeenCalledTimes(1)
  })

  it('bounds total pagination at 1000 pages', async () => {
    const api = client()
    let page = 0
    api.message.list.mockImplementation(async () => ({
      data: [assistant(`message-${++page}`)],
      cursor: { next: `cursor-${page}` },
    }))
    const { usage } = await captureScheduleRunUsage(api, 'root')
    expect(usage).toMatchObject({
      error: 'USAGE_SNAPSHOT_LIMIT',
      totals: { cost: 2, messages: 1000 },
    })
    expect(page).toBe(1000)
  })

  it.each(['root', 'messages', 'children'] as const)(
    'times out stalled %s, aborts the SDK, and prevents late mutations',
    async (stage) => {
      vi.useFakeTimers()
      const api = client()
      const pending = Promise.withResolvers<Awaited<ReturnType<OpenCodeApi['message']['list']>>>()
      const root = Promise.withResolvers<SessionInfo>()
      const children = Promise.withResolvers<Awaited<ReturnType<OpenCodeApi['session']['list']>>>()
      if (stage === 'root') api.session.get.mockReturnValue(root.promise)
      if (stage === 'messages') api.message.list.mockReturnValue(pending.promise)
      if (stage === 'children') api.session.list.mockReturnValue(children.promise)
      const capture = captureScheduleRunUsage(api, 'root')
      await vi.advanceTimersByTimeAsync(5000)
      const result = await capture
      const before = structuredClone(result)
      expect(result.usage).toMatchObject({
        error: 'USAGE_SNAPSHOT_TIMEOUT',
        sessions: stage === 'root' ? 0 : 1,
      })
      expect(api.session.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      root.resolve(session('root'))
      pending.resolve({ data: [assistant('late')], cursor: { next: 'late' } })
      children.resolve({
        data: [session('late-child', 'root')],
        cursor: { next: 'late' },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(result).toEqual(before)
      expect(api.message.list.mock.calls.length).toBe(stage === 'root' ? 0 : 1)
      expect(api.session.list.mock.calls.length).toBe(stage === 'children' ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

describe('buildFailedUsage', () => {
  it.each(['USAGE_SNAPSHOT_LIMIT', 'USAGE_SNAPSHOT_TIMEOUT', 'USAGE_SESSION_NOT_FOUND', 'provider-secret'])(
    'only exposes safe codes for %s',
    (error) => {
      expect(buildFailedUsage(error, additional)).toMatchObject({
        sessions: 0,
        totals: zero,
        byModel: {},
        additional,
        error: error === 'provider-secret' ? 'USAGE_SNAPSHOT_FAILED' : error,
      })
    },
  )
})
