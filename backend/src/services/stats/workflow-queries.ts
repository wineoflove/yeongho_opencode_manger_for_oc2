import type { Database } from 'bun:sqlite'
import type { WorkflowMessage, WorkflowSession, WorkflowStep, WorkflowToolPart } from './workflow-types'

export type WorkflowBounds = { readonly from: number; readonly to: number }
export type WorkflowRowRange = {
  readonly after: number
  readonly through: number
}

type MessageRow = {
  readonly id: string
  readonly sessionId: string
  readonly type: string
  readonly time: number
  readonly data: string
}

type PartRow = {
  readonly messageId: string
  readonly ordinal: number
  readonly data: string
}

export type WorkflowMessageBatch = {
  readonly messages: WorkflowMessage[]
  readonly tools: WorkflowToolPart[]
  readonly steps: WorkflowStep[]
}

export const sessionColumns =
  "s.id, s.parent_id AS parentId, coalesce(s.title, '') AS title, s.time_created AS timeCreated, s.directory"
const messageColumns = 'm.id, m.session_id AS sessionId, m.type, m.time_created AS time, m.data'
const WORKFLOW_TYPES = "('user', 'assistant', 'compaction')"
const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ')

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parse(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function errorText(value: unknown): string | null {
  if (typeof value === 'string') return value
  const message = object(value).message
  if (typeof message === 'string') return message
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map((item) => text(object(item).text) ?? '').join('')
}

function toolName(name: string): string {
  return name === 'shell' ? 'bash' : name
}

function toolPart(message: MessageRow, ordinal: number, entry: Record<string, unknown>): WorkflowToolPart | null {
  if (entry.type !== 'tool' || typeof entry.name !== 'string') return null
  const tool = toolName(entry.name)
  const state = object(entry.state)
  const input = object(state.input)
  const metadata = object(state.metadata)
  const serializedInput = state.input === undefined ? null : JSON.stringify(state.input)
  const output = contentText(state.content)
  const exit = metadata.exit
  const filePath = text(input.filePath) ?? text(input.path)
  return {
    id: `${message.id}:${ordinal}`,
    sessionId: message.sessionId,
    messageId: message.id,
    time: num(object(entry.time).created) || message.time,
    tool,
    status: typeof state.status === 'string' ? state.status : 'unknown',
    error: errorText(state.error)?.slice(0, 600) ?? null,
    inputHead: serializedInput?.slice(0, 2000) ?? null,
    inputLength: serializedInput?.length ?? null,
    command: tool === 'bash' ? (text(input.command)?.slice(0, 4000) ?? null) : null,
    filePath,
    exit: typeof exit === 'number' || typeof exit === 'string' ? exit : null,
    outputTail: tool === 'bash' && output ? output.slice(-2000) : null,
    metaOutputTail: tool === 'bash' ? (text(metadata.output)?.slice(-2000) ?? null) : null,
    timedOut:
      metadata.status === 'timeout' || metadata.timedOut === true ? true : metadata.status === undefined ? null : false,
    guardId: text(object(metadata.ocmGuard).id),
  }
}

function readParts(db: Database, messageIds: readonly string[]): Map<string, Record<string, unknown>[]> {
  const result = new Map<string, Record<string, unknown>[]>()
  if (messageIds.length === 0) return result
  const rows = db
    .query<PartRow, string[]>(
      `SELECT message_id AS messageId, ordinal, data FROM session_part
      WHERE message_id IN (${placeholders(messageIds.length)}) ORDER BY message_id, ordinal`,
    )
    .all(...messageIds)
  for (const row of rows) {
    const list = result.get(row.messageId) ?? []
    list.push(parse(row.data))
    result.set(row.messageId, list)
  }
  return result
}

function decode(db: Database, rows: readonly MessageRow[]): WorkflowMessageBatch {
  const messages: WorkflowMessage[] = []
  const tools: WorkflowToolPart[] = []
  const steps: WorkflowStep[] = []
  const parts = readParts(
    db,
    rows.filter((row) => row.type === 'assistant').map((row) => row.id),
  )
  for (const row of rows) {
    const data = parse(row.data)
    const time = num(object(data.time).created) || row.time
    const agent = text(data.agent)
    if (row.type === 'compaction') {
      messages.push({
        id: row.id,
        sessionId: row.sessionId,
        time,
        role: 'assistant',
        summary: true,
        error: data.status === 'failed' ? (errorText(data.error) ?? 'failed') : null,
        agent: null,
      })
      continue
    }
    messages.push({
      id: row.id,
      sessionId: row.sessionId,
      time,
      role: row.type,
      summary: false,
      error: errorText(data.error),
      agent,
    })
    if (row.type !== 'assistant') continue
    const content = parts.get(row.id) ?? (Array.isArray(data.content) ? data.content.map(object) : [])
    content.forEach((entry, ordinal) => {
      const tool = toolPart({ ...row, time }, ordinal, entry)
      if (tool) tools.push(tool)
    })
    const tokens = object(data.tokens)
    const cache = object(tokens.cache)
    const model = object(data.model)
    const step: WorkflowStep = {
      sessionId: row.sessionId,
      messageId: row.id,
      time,
      agent,
      providerID: text(model.providerID),
      modelID: text(model.id),
      input: num(tokens.input),
      output: num(tokens.output),
      cacheRead: num(cache.read),
      cacheWrite: num(cache.write),
    }
    if (step.input + step.output + step.cacheRead + step.cacheWrite > 0) steps.push(step)
  }
  return { messages, tools, steps }
}

export function readMaxRowId(db: Database): number {
  return db.query<{ id: number }, []>('SELECT coalesce(max(rowid), 0) AS id FROM session_message').get()?.id ?? 0
}

export function readMessageBatch(db: Database, rows: WorkflowRowRange, bounds: WorkflowBounds): WorkflowMessageBatch {
  return decode(
    db,
    db
      .query<MessageRow, [number, number, number, number]>(
        `SELECT ${messageColumns} FROM session_message m
        WHERE m.rowid > ? AND m.rowid <= ? AND m.time_created >= ? AND m.time_created < ? AND m.type IN ${WORKFLOW_TYPES}
        ORDER BY m.rowid`,
      )
      .all(rows.after, rows.through, bounds.from, bounds.to),
  )
}

export function readSessionBatch(db: Database, sessionId: string): WorkflowMessageBatch {
  return decode(
    db,
    db
      .query<MessageRow, [string]>(
        `SELECT ${messageColumns} FROM session_message m
        WHERE m.session_id = ? AND m.type IN ${WORKFLOW_TYPES} ORDER BY m.seq LIMIT 4000`,
      )
      .all(sessionId),
  )
}

export function readSessionsInWindow(db: Database, bounds: WorkflowBounds): WorkflowSession[] {
  return db
    .query<WorkflowSession, [number, number]>(
      `SELECT ${sessionColumns} FROM session_v2 s WHERE s.time_created >= ? AND s.time_created < ?`,
    )
    .all(bounds.from, bounds.to)
}

export function readSessionsById(db: Database, ids: readonly string[]): WorkflowSession[] {
  return db
    .query<WorkflowSession, string[]>(
      `SELECT ${sessionColumns} FROM session_v2 s WHERE s.id IN (${placeholders(ids.length)})`,
    )
    .all(...ids)
}
