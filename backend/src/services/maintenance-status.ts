import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { z } from 'zod'
import { getAssistantModePath, getReposPath, getWorkspacePath } from '@opencode-manager/shared/config/env'
import type { OpenCodeClient } from './opencode/client'
import { maintenanceAdmission } from './maintenance-admission'

const reposSchema = z.array(
  z.object({
    local_path: z.string().min(1),
    source_path: z.string().min(1).nullable(),
  }),
)
const countSchema = z.object({ count: z.number().int().nonnegative() })
const activeSchema = z.record(z.string(), z.object({}).passthrough())
const terminalsSchema = z.object({ data: z.array(z.object({}).passthrough()) })
const sessionPageSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
  cursor: z.object({ next: z.string().min(1).nullish() }),
})
const persistentPtySchema = z.array(z.object({ id: z.string().min(1) }))

/** Reason a maintenance window is not safe to open. */
export type MaintenanceBlocker =
  | 'enabled_schedules'
  | 'active_schedules'
  | 'active_recovery'
  | 'busy_sessions'
  | 'terminal_sessions'
  | 'directories_unknown'
  | 'session_status_unknown'
  | 'pending_handlers'
  | 'admission_changed'
  | 'persistent_pty_unknown'

/** Counts behind a maintenance readiness decision; `activeRecovery` counts active session goals that resume work. */
export interface MaintenanceCounts {
  enabledSchedules: number
  activeSchedules: number
  activeRecovery: number
  busySessions: number
  terminalSessions: number
  checkedDirectories: number
  /** Outstanding HTTP handler and inference transport leases; one request can temporarily hold both. */
  pendingHandlers: number
  persistentTerminalSessions: number
}

/** Readiness of the Manager and its OpenCode 2 server for a restart or deployment; unknown evidence fails closed. */
export interface MaintenanceStatus {
  admission: ReturnType<typeof maintenanceAdmission.status>
  schemaVersion: 1
  ready: boolean
  drained: boolean
  scope: 'manager-admission-and-local-native-snapshot'
  directories: { registered: string[]; attempted: string[]; checked: string[] }
  persistentPty: { sessions: string[]; checked: string[] }
  counts: MaintenanceCounts
  blockers: MaintenanceBlocker[]
}

const QUERIES = [
  ['enabledSchedules', 'enabled_schedules', 'SELECT COUNT(*) AS count FROM schedule_jobs WHERE enabled = 1'],
  [
    'activeSchedules',
    'active_schedules',
    "SELECT COUNT(*) AS count FROM schedule_runs WHERE status IS NULL OR status NOT IN ('completed', 'failed', 'cancelled')",
  ],
  ['activeRecovery', 'active_recovery', "SELECT COUNT(*) AS count FROM session_goals WHERE status = 'active'"],
] as const

/** Collects maintenance readiness from Manager records and the OpenCode 2 session and terminal APIs. */
export async function getMaintenanceStatus(
  db: Database,
  client: Pick<OpenCodeClient, 'api'>,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<MaintenanceStatus> {
  const initialAdmission = maintenanceAdmission.status()
  const counts: MaintenanceCounts = {
    enabledSchedules: 0,
    activeSchedules: 0,
    activeRecovery: 0,
    busySessions: 0,
    terminalSessions: 0,
    checkedDirectories: 0,
    pendingHandlers: 0,
    persistentTerminalSessions: 0,
  }
  const blockers = new Set<MaintenanceBlocker>()
  for (const [key, blocker, query] of QUERIES) {
    try {
      counts[key] = countSchema.parse(db.query(query).get()).count
      if (counts[key] > 0) blockers.add(blocker)
    } catch {
      blockers.add(blocker)
    }
  }
  try {
    counts.busySessions = Object.keys(activeSchema.parse(await client.api.session.active({ signal }))).length
    if (counts.busySessions > 0) blockers.add('busy_sessions')
  } catch {
    blockers.add('session_status_unknown')
  }
  const directories = new Set([getWorkspacePath(), getAssistantModePath()])
  let registered: string[] = []
  const checked: string[] = []
  try {
    registered = z.array(z.object({ directory: z.string().min(1) }))
      .parse(await client.api.debug.location.list({ signal })).map((location) => location.directory)
    for (const directory of registered) directories.add(directory)
  } catch {
    blockers.add('directories_unknown')
  }
  try {
    for (const repo of reposSchema.parse(db.query('SELECT local_path, source_path FROM repos').all()))
      directories.add(repo.source_path ?? resolve(getReposPath(), repo.local_path))
  } catch {
    blockers.add('directories_unknown')
  }
  for (const directory of directories) {
    try {
      const terminals = terminalsSchema.parse(await client.api.pty.list({ location: { directory } }, { signal }))
      counts.terminalSessions += terminals.data.length
      counts.checkedDirectories += 1
      checked.push(directory)
    } catch {
      blockers.add('directories_unknown')
    }
  }
  if (counts.terminalSessions > 0) blockers.add('terminal_sessions')
  const sessions = new Set<string>()
  const checkedSessions: string[] = []
  try {
    for (const archived of [false, true]) {
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        signal.throwIfAborted()
        const page = sessionPageSchema.parse(await client.api.session.list({ archived, cursor, limit: 100 }, { signal }))
        for (const session of page.data) sessions.add(session.id)
        cursor = page.cursor.next ?? undefined
        if (cursor && cursors.has(cursor)) throw new Error('Repeated session cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
    }
    for (const sessionID of sessions) {
      signal.throwIfAborted()
      const terminals = persistentPtySchema.parse(await client.api.experimental.persistentPty.list({ sessionID }, { signal }))
      counts.persistentTerminalSessions += terminals.length
      checkedSessions.push(sessionID)
    }
  } catch {
    blockers.add('persistent_pty_unknown')
  }
  if (counts.persistentTerminalSessions > 0) blockers.add('terminal_sessions')
  const admission = maintenanceAdmission.status()
  counts.pendingHandlers = admission.pendingHandlers
  if (counts.pendingHandlers > 0) blockers.add('pending_handlers')
  if (initialAdmission.revision !== admission.revision || initialAdmission.closed !== admission.closed)
    blockers.add('admission_changed')
  return {
    schemaVersion: 1,
    admission,
    ready: blockers.size === 0,
    drained: admission.closed && admission.sealed && blockers.size === 0,
    scope: 'manager-admission-and-local-native-snapshot',
    directories: { registered, attempted: [...directories], checked },
    persistentPty: { sessions: [...sessions], checked: checkedSessions },
    counts,
    blockers: [...blockers],
  }
}
