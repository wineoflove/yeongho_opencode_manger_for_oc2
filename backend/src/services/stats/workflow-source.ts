import { Database } from 'bun:sqlite'
import {
  WorkflowRangeSchema,
  WorkflowSessionTimelineSchema,
  WorkflowStatsResponseSchema,
  type WorkflowRange,
  type WorkflowStatsResponse,
} from '@opencode-manager/shared/schemas'
import { logger } from '../../utils/logger'
import { computeWorkflowStats } from './workflow-metrics'
import { prepareWorkflowToolPart } from './workflow-classifiers'
import {
  readMaxRowId,
  readMessageBatch,
  readSessionBatch,
  readSessionsById,
  readSessionsInWindow,
  sessionColumns,
  type WorkflowRowRange,
} from './workflow-queries'
import type { WorkflowMessage, WorkflowSession, WorkflowStep, PreparedWorkflowToolPart } from './workflow-types'

export class WorkflowSourceIncompatibleError extends Error {
  constructor() {
    super('WORKFLOW_SOURCE_INCOMPATIBLE')
  }
}

export class WorkflowSessionIdError extends Error {
  constructor() {
    super('WORKFLOW_SESSION_INVALID_ID')
  }
}

type WorkflowSourceOptions = {
  readonly openCodeDbPath: string
  readonly searchLessons: (queries: readonly string[]) => Promise<readonly { query: string; ids: string[] }[]>
  readonly mcpStatus: () => Promise<{ directory: string; statuses: Record<string, { status: string }> }>
  readonly now?: () => number
}

const HOUR = 3_600_000
const ID_BATCH = 500
const TARGET_SLICE_MS = 30
const MIN_BATCH_ROWS = 25
const MAX_BATCH_ROWS = 500
const durations = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR }
const requiredColumns = {
  session_v2: ['id', 'parent_id', 'title', 'time_created', 'directory'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'data'],
  session_part: ['message_id', 'ordinal', 'data'],
}

async function optionalLookup<T>(lookup: () => Promise<T>, name: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WORKFLOW_LOOKUP_TIMEOUT')), 15_000)
      }),
    ])
  } catch {
    logger.warn('Workflow enrichment unavailable', { lookup: name })
    return null
  } finally {
    clearTimeout(timer)
  }
}

export class WorkflowStatsSource {
  private readonly cache = new Map<WorkflowRange, { expiresAt: number; value: WorkflowStatsResponse }>()
  private readonly pending = new Map<WorkflowRange, Promise<WorkflowStatsResponse>>()
  private readonly now: () => number

  constructor(private readonly options: WorkflowSourceOptions) {
    this.now = options.now ?? Date.now
  }

  private database() {
    const db = new Database(this.options.openCodeDbPath, { readonly: true })
    try {
      for (const [table, required] of Object.entries(requiredColumns)) {
        const columns = new Set(
          db
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        )
        if (required.some((column) => !columns.has(column))) throw new WorkflowSourceIncompatibleError()
      }
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  getStats(range: WorkflowRange): Promise<WorkflowStatsResponse> {
    const parsedRange = WorkflowRangeSchema.parse(range)
    const cached = this.cache.get(parsedRange)
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value)
    const pending = this.pending.get(parsedRange)
    if (pending) return pending
    const computation = this.compute(parsedRange)
    this.pending.set(parsedRange, computation)
    return computation
  }

  private async compute(range: WorkflowRange): Promise<WorkflowStatsResponse> {
    const started = performance.now()
    try {
      await Promise.resolve()
      const generatedAt = this.now()
      const window = { from: generatedAt - durations[range], to: generatedAt }
      const previousWindow = { from: window.from - durations[range], to: window.from }
      const bounds = { from: previousWindow.from, to: window.to }
      const tools: PreparedWorkflowToolPart[] = []
      const steps: WorkflowStep[] = []
      const messages = new Map<string, WorkflowMessage>()
      const sessions = new Map<string, WorkflowSession>()
      const sessionIds = new Set<string>()
      let maxSliceMs = 0
      const slice = async (work: () => void) => {
        const sliceStarted = performance.now()
        work()
        const elapsed = performance.now() - sliceStarted
        maxSliceMs = Math.max(maxSliceMs, elapsed)
        await new Promise((resolve) => setTimeout(resolve, 0))
        return elapsed
      }
      const scan = async (lastRowId: number, read: (rows: WorkflowRowRange) => void) => {
        let size = MIN_BATCH_ROWS
        let after = 0
        while (after < lastRowId) {
          const through = after + size
          const elapsed = await slice(() => read({ after, through }))
          size = Math.min(
            MAX_BATCH_ROWS,
            Math.max(MIN_BATCH_ROWS, Math.round(size * Math.min(2, TARGET_SLICE_MS / Math.max(elapsed, 1)))),
          )
          after = through
        }
      }
      const db = this.database()
      try {
        await scan(readMaxRowId(db), (batch) => {
          const rows = readMessageBatch(db, batch, bounds)
          for (const message of rows.messages) {
            messages.set(message.id, message)
            sessionIds.add(message.sessionId)
          }
          for (const row of rows.tools) tools.push(prepareWorkflowToolPart(row))
          steps.push(...rows.steps)
        })
        await slice(() => {
          for (const row of readSessionsInWindow(db, bounds)) sessions.set(row.id, row)
        })
        const missingSessions = [...sessionIds].filter((id) => !sessions.has(id))
        for (let index = 0; index < missingSessions.length; index += ID_BATCH)
          await slice(() => {
            for (const row of readSessionsById(db, missingSessions.slice(index, index + ID_BATCH)))
              sessions.set(row.id, row)
          })
      } finally {
        db.close()
      }
      const postScanStarted = performance.now()
      steps.sort((left, right) => left.time - right.time || (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0))
      const computed = computeWorkflowStats({
        range,
        window,
        previousWindow,
        tools,
        steps,
        messages: [...messages.values()],
        sessions: [...sessions.values()],
        readPaths: tools
          .filter((part) => part.tool === 'read')
          .map((part) => ({ sessionId: part.sessionId, time: part.time, filePath: part.filePath })),
      })
      const queries = computed.errorSignatures.map((row) =>
        row.signature
          .replace(/<(?:N|PATH|ID|URL)>/g, ' ')
          .split(/\s+/)
          .filter((word) => word.length >= 4)
          .sort((left, right) => right.length - left.length)
          .slice(0, 2)
          .join(' '),
      )
      const postScanMs = performance.now() - postScanStarted
      const [lessons, mcp] = await Promise.all([
        optionalLookup(() => this.options.searchLessons(queries), 'lessons'),
        optionalLookup(this.options.mcpStatus, 'mcp'),
      ])
      const lessonIds = lessons === null ? null : new Map(lessons.map((row) => [row.query, row.ids]))
      const statuses = new Map(Object.entries(mcp?.statuses ?? {}).map(([name, value]) => [`${name}_`, value.status]))
      const schemaStarted = performance.now()
      const value = WorkflowStatsResponseSchema.parse({
        ...computed,
        generatedAt,
        window,
        previousWindow,
        errorSignatures: computed.errorSignatures.map((row, index) => ({
          ...row,
          relatedLessonIds: lessonIds === null ? null : (lessonIds.get(queries[index] ?? '') ?? []),
        })),
        mcp: computed.mcp.map((row) => ({ ...row, status: statuses.get(row.prefix) ?? null })),
        mcpStatusSource: mcp?.directory ?? null,
      })
      this.cache.set(range, { value, expiresAt: this.now() + 600_000 })
      logger.info('Workflow statistics computed', {
        range,
        maxSliceMs,
        postScanMs,
        schemaMs: performance.now() - schemaStarted,
        totalMs: performance.now() - started,
      })
      return value
    } finally {
      this.pending.delete(range)
    }
  }

  async getSessionTimeline(sessionId: string) {
    if (!/^ses_[A-Za-z0-9]{10,40}$/.test(sessionId)) throw new WorkflowSessionIdError()
    const db = this.database()
    try {
      const session = db
        .query<WorkflowSession & { directory: string }, [string]>(
          `SELECT ${sessionColumns} FROM session_v2 s WHERE s.id = ?`,
        )
        .get(sessionId)
      if (!session) return null
      const batch = readSessionBatch(db, sessionId)
      const countsByMessage = new Map<string, { toolCalls: number; toolErrors: number; guardEvents: number }>()
      for (const tool of batch.tools) {
        const counts = countsByMessage.get(tool.messageId) ?? { toolCalls: 0, toolErrors: 0, guardEvents: 0 }
        counts.toolCalls += 1
        if (tool.status === 'error') counts.toolErrors += 1
        if (
          tool.guardId === 'G3' ||
          tool.guardId === 'G4' ||
          (tool.status === 'error' && (tool.error?.includes('OCM_GUARD_G1') || tool.error?.includes('OCM_GUARD_G3')))
        )
          counts.guardEvents += 1
        countsByMessage.set(tool.messageId, counts)
      }
      const steps = batch.steps.slice(0, 2000).map((step) => {
        const counts = countsByMessage.get(step.messageId)
        return {
          at: step.time,
          messageId: step.messageId,
          agent: step.agent,
          model: step.modelID === null ? null : step.providerID ? `${step.providerID}/${step.modelID}` : step.modelID,
          contextTokens: step.input + step.cacheRead + step.cacheWrite,
          outputTokens: step.output,
          toolCalls: counts?.toolCalls ?? 0,
          toolErrors: counts?.toolErrors ?? 0,
          guardEvents: counts?.guardEvents ?? 0,
        }
      })
      const compactions = batch.messages
        .filter((message) => message.summary === true)
        .map((message) => ({ at: message.time, messageId: message.id }))
      return WorkflowSessionTimelineSchema.parse({
        sessionId,
        title: session.title,
        directory: session.directory,
        parentId: session.parentId,
        steps,
        compactions,
      })
    } finally {
      db.close()
    }
  }
}
