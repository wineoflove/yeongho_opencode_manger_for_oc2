import type { Migration } from '../migration-runner'

export const scheduleRunSubmissionsMigration: Migration = {
  id: '202611061545-schedule-run-submissions',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS schedule_run_submissions (
        run_id INTEGER PRIMARY KEY REFERENCES schedule_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged')),
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        CHECK ((state = 'pending' AND acknowledged_at IS NULL)
          OR (state = 'acknowledged' AND acknowledged_at IS NOT NULL))
      )
    `)
  },
  down(db) {
    db.run('DROP TABLE IF EXISTS schedule_run_submissions')
  },
}
