import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const submissionSchema = z.object({
  session_id: z.string(),
  message_id: z.string(),
  state: z.enum(['pending', 'acknowledged']),
})

export function getScheduleSubmission(db: Database, runId: number) {
  const row = db
    .prepare('SELECT session_id, message_id, state FROM schedule_run_submissions WHERE run_id = ?')
    .get(runId)
  return row ? submissionSchema.parse(row) : null
}

export class ScheduleSubmissionPersistenceError extends Error {
  constructor(readonly runId: number) {
    super('SUBMISSION_PERSISTENCE_FAILED: Could not persist schedule submission state.')
    this.name = 'ScheduleSubmissionPersistenceError'
  }
}

export function beginScheduleSubmission(
  db: Database,
  input: {
    readonly runId: number
    readonly sessionId: string
    readonly messageId: string
    readonly createdAt: number
  },
): void {
  const row = db
    .prepare(
      `
    INSERT INTO schedule_run_submissions (run_id, session_id, message_id, state, created_at)
    SELECT id, session_id, ?, 'pending', ? FROM schedule_runs
    WHERE id = ? AND session_id = ? AND status = 'running'
    RETURNING run_id
  `,
    )
    .get(input.messageId, input.createdAt, input.runId, input.sessionId)
  if (!row) throw new ScheduleSubmissionPersistenceError(input.runId)
}

export function acknowledgeScheduleSubmission(
  db: Database,
  input: {
    readonly runId: number
    readonly messageId: string
    readonly acknowledgedAt: number
  },
): void {
  const row = db
    .prepare(
      `
    UPDATE schedule_run_submissions SET state = 'acknowledged', acknowledged_at = ?
    WHERE run_id = ? AND message_id = ? AND state = 'pending'
    RETURNING run_id
  `,
    )
    .get(input.acknowledgedAt, input.runId, input.messageId)
  if (!row) throw new ScheduleSubmissionPersistenceError(input.runId)
}
