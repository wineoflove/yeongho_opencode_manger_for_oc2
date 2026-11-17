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

/** Reason a maintenance window is not safe to open. */
export type MaintenanceBlocker =
  | 'enabled_schedules'
  | 'active_schedules'
  | 'active_recovery'
  | 'busy_sessions'
  | 'terminal_sessions'
  | 'directories_unknown'
  | 'session_status_unknown'

/** Counts behind a maintenance readiness decision; `activeRecovery` counts active session goals that resume work. */
export interface MaintenanceCounts {
  enabledSchedules: number
  activeSchedules: number
  activeRecovery: number
  busySessions: number
  terminalSessions: number
  checkedDirectories: number
}

/** Readiness of the Manager and its OpenCode 2 server for a restart or deployment; unknown evidence fails closed. */
export interface MaintenanceStatus {
  admission: { readonly configured: boolean; readonly closed: boolean }
  schemaVersion: 1
  ready: boolean
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
  const counts: MaintenanceCounts = {
    enabledSchedules: 0,
    activeSchedules: 0,
    activeRecovery: 0,
    busySessions: 0,
    terminalSessions: 0,
    checkedDirectories: 0,
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
    } catch {
      blockers.add('directories_unknown')
    }
  }
  if (counts.terminalSessions > 0) blockers.add('terminal_sessions')
  return {
    schemaVersion: 1,
    admission: maintenanceAdmission.status(),
    ready: blockers.size === 0,
    counts,
    blockers: [...blockers],
  }
}
