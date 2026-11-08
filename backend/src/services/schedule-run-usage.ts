import { ScheduleUsageTotalsSchema } from '@opencode-manager/shared/schemas'
import type { ScheduleAdditionalUsage, ScheduleRunUsage, ScheduleUsageTotals } from '@opencode-manager/shared/schemas'
import { isSessionNotFoundError } from '@opencode-manager/shared/opencode'
import type { OpenCodeApi, SessionInfo, SessionMessageAssistant } from '@opencode-manager/shared/opencode'

type UsageApi = {
  readonly session: Pick<OpenCodeApi['session'], 'get' | 'list'>
  readonly message: Pick<OpenCodeApi['message'], 'list'>
}
type UsageErrorCode =
  'USAGE_SESSION_NOT_FOUND' | 'USAGE_SNAPSHOT_FAILED' | 'USAGE_SNAPSHOT_LIMIT' | 'USAGE_SNAPSHOT_TIMEOUT'
class UsageError extends Error {
  constructor(readonly code: UsageErrorCode) {
    super(code)
  }
}
function safeCode(error: string): UsageErrorCode {
  switch (error) {
    case 'USAGE_SESSION_NOT_FOUND':
    case 'USAGE_SNAPSHOT_LIMIT':
    case 'USAGE_SNAPSHOT_TIMEOUT':
      return error
    default:
      return 'USAGE_SNAPSHOT_FAILED'
  }
}
function emptyTotals(): ScheduleUsageTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    messages: 0,
  }
}
export function buildFailedUsage(error: string, additional: ScheduleAdditionalUsage | null): ScheduleRunUsage {
  return {
    computedAt: Date.now(),
    sessions: 0,
    totals: emptyTotals(),
    byModel: {},
    additional,
    error: safeCode(error),
  }
}
function addUsage(
  total: ScheduleUsageTotals,
  value: Pick<SessionMessageAssistant, 'cost' | 'tokens'>,
  messages = 0,
): ScheduleUsageTotals {
  const amount = ScheduleUsageTotalsSchema.parse({
    input: value.tokens?.input ?? 0,
    output: value.tokens?.output ?? 0,
    reasoning: value.tokens?.reasoning ?? 0,
    cacheRead: value.tokens?.cache.read ?? 0,
    cacheWrite: value.tokens?.cache.write ?? 0,
    cost: value.cost ?? 0,
    messages,
  })
  return ScheduleUsageTotalsSchema.parse({
    input: total.input + amount.input,
    output: total.output + amount.output,
    reasoning: total.reasoning + amount.reasoning,
    cacheRead: total.cacheRead + amount.cacheRead,
    cacheWrite: total.cacheWrite + amount.cacheWrite,
    cost: total.cost + amount.cost,
    messages: total.messages + amount.messages,
  })
}

export async function captureScheduleRunUsage(
  api: UsageApi,
  rootSessionId: string,
  additional: ScheduleAdditionalUsage | null = null,
): Promise<{ usage: ScheduleRunUsage; agentUsed: string | null }> {
  const usage = buildFailedUsage('USAGE_SNAPSHOT_FAILED', additional)
  const controller = new AbortController()
  const deadline = Date.now() + 5000
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    timeout.reject(new UsageError('USAGE_SNAPSHOT_TIMEOUT'))
    controller.abort()
  }, 5000)
  let pages = 0
  let agentUsed: string | null = null
  let rootLoaded = false
  const models = new Map<string, ScheduleUsageTotals>()
  const visited = new Set<string>()
  const queue: SessionInfo[] = []
  const requestOptions = { signal: controller.signal }
  function checkDeadline() {
    if (controller.signal.aborted || Date.now() >= deadline) throw new UsageError('USAGE_SNAPSHOT_TIMEOUT')
  }
  async function request<T>(operation: () => Promise<T>): Promise<T> {
    checkDeadline()
    const result = await Promise.race([operation(), timeout.promise])
    checkDeadline()
    return result
  }
  async function* paginate<T>(load: (cursor?: string) => Promise<{ data: T[]; cursor: { next?: string | null } }>) {
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      checkDeadline()
      if (pages >= 1000) throw new UsageError('USAGE_SNAPSHOT_LIMIT')
      pages++
      const page = await request(() => load(cursor))
      const next = page.cursor.next
      if (next && (page.data.length === 0 || cursors.has(next))) throw new UsageError('USAGE_SNAPSHOT_FAILED')
      if (page.data.length > 100) throw new UsageError('USAGE_SNAPSHOT_LIMIT')
      yield page.data
      if (!next) return
      cursors.add(next)
      cursor = next
    } while (true)
  }
  function include(session: SessionInfo) {
    if (visited.has(session.id)) return
    if (visited.size >= 100) throw new UsageError('USAGE_SNAPSHOT_LIMIT')
    usage.totals = addUsage(usage.totals, session)
    visited.add(session.id)
    usage.sessions++
    queue.push(session)
  }
  try {
    const root = await request(() => api.session.get({ sessionID: rootSessionId }, requestOptions))
    rootLoaded = true
    if (root.id !== rootSessionId) throw new UsageError('USAGE_SNAPSHOT_FAILED')
    include(root)
    for (const session of queue) {
      checkDeadline()
      if (session.fork) throw new UsageError('USAGE_SNAPSHOT_FAILED')
      const messages = new Set<string>()
      for await (const page of paginate((cursor) =>
        api.message.list(
          {
            sessionID: session.id,
            type: 'assistant',
            limit: 100,
            ...(cursor ? { cursor } : { order: 'asc' }),
          },
          requestOptions,
        ),
      )) {
        for (const message of page) {
          if (message.type !== 'assistant' || messages.has(message.id)) throw new UsageError('USAGE_SNAPSHOT_FAILED')
          const model = `${message.model.providerID}/${message.model.id}`
          const total = addUsage(models.get(model) ?? emptyTotals(), message, 1)
          models.set(model, total)
          messages.add(message.id)
          usage.totals.messages++
          if (session.id === rootSessionId && agentUsed === null) agentUsed = message.agent
        }
      }
      for await (const page of paginate((cursor) =>
        api.session.list(
          {
            parentID: session.id,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          requestOptions,
        ),
      )) {
        for (const child of page) {
          if (child.parentID !== session.id) throw new UsageError('USAGE_SNAPSHOT_FAILED')
          include(child)
        }
      }
    }
    usage.error = null
  } catch (error) {
    usage.error =
      error instanceof UsageError
        ? error.code
        : !rootLoaded && isSessionNotFoundError(error)
          ? 'USAGE_SESSION_NOT_FOUND'
          : 'USAGE_SNAPSHOT_FAILED'
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  usage.byModel = Object.fromEntries(models)
  return { usage, agentUsed }
}
