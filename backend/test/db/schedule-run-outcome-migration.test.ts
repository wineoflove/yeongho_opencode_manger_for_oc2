import { describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE } from '../../src/db/migrations/202610181319-preserve-fork-schedule-outcomes'

const FIRST_UPSTREAM_ONLY_MIGRATION = '021-drop-schedule-run-workspace-id'

const OUTCOME_COLUMNS = ['outcome', 'outcome_json', 'usage_json', 'agent_used']

interface RunOutcomeRow {
  id: number
  status: string
  outcome: string | null
  outcome_json: string | null
  usage_json: string | null
  agent_used: string | null
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function runColumns(db: Database): string[] {
  return (db.prepare('PRAGMA table_info(schedule_runs)').all() as Array<{ name: string }>).map((column) => column.name)
}

function outcomeRows(db: Database): RunOutcomeRow[] {
  return db
    .prepare('SELECT id, status, outcome, outcome_json, usage_json, agent_used FROM schedule_runs ORDER BY id')
    .all() as RunOutcomeRow[]
}

/** Builds a database at the fork's schema: upstream migrations through 020 plus the fork's outcome columns. */
function createForkDatabase(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const cut = allMigrations.findIndex((migration) => migration.id === FIRST_UPSTREAM_ONLY_MIGRATION)
  migrate(db, allMigrations.slice(0, cut))
  for (const column of OUTCOME_COLUMNS) {
    db.run(`ALTER TABLE schedule_runs ADD COLUMN ${column} TEXT`)
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_schedule_runs_session_id ON schedule_runs(session_id)')

  const now = Date.now()
  db.exec(
    `INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
     VALUES (1, 'https://github.com/test/repo', 'repos/repo', 'main', 'main', 'ready', ${now})`,
  )
  db.prepare(
    `INSERT INTO schedule_jobs (id, repo_id, name, enabled, schedule_mode, prompt, created_at, updated_at)
     VALUES (3, 1, 'Daily review', 1, 'interval', 'Review', ?, ?)`,
  ).run(now, now)
  const insertRun = db.prepare(
    `INSERT INTO schedule_runs (id, job_id, repo_id, trigger_source, status, started_at, created_at, session_id,
       outcome, outcome_json, usage_json, agent_used)
     VALUES (?, 3, 1, 'schedule', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const report = JSON.stringify({ outcome: 'succeeded', summary: '보고서 게시', reportedAt: now, agent: 'assistant', reportCount: 1 })
  const usage = JSON.stringify({ computedAt: now, sessions: 1, totals: { input: 10 }, byModel: {}, additional: null, error: null })
  insertRun.run(1, 'completed', now, now, 'ses_reported', 'succeeded', report, usage, 'assistant')
  insertRun.run(2, 'completed', now, now, 'ses_unreported', 'unreported', null, usage, 'assistant')
  insertRun.run(3, 'failed', now, now, 'ses_plain', null, null, null, null)
  return db
}

describe('schedule run outcome migrations', () => {
  it('keeps fork outcome reports and usage snapshots through the schedule table rebuild', () => {
    const db = createForkDatabase()
    const before = outcomeRows(db)

    migrate(db, allMigrations)

    expect(outcomeRows(db)).toEqual(before)
    expect(tableExists(db, PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE)).toBe(false)
    const run = db.prepare('SELECT server_id, session_id FROM schedule_runs WHERE id = 1').get() as Record<string, unknown>
    expect(run).toEqual({ server_id: 'local', session_id: 'ses_reported' })
  })

  it('leaves the restored database unchanged when migrations run again', () => {
    const db = createForkDatabase()
    migrate(db, allMigrations)
    const restored = outcomeRows(db)
    const appliedBefore = db.prepare('SELECT COUNT(*) AS count FROM applied_migrations').get()

    migrate(db, allMigrations)

    expect(outcomeRows(db)).toEqual(restored)
    expect(db.prepare('SELECT COUNT(*) AS count FROM applied_migrations').get()).toEqual(appliedBefore)
  })

  it('adds empty outcome columns to a new database without leaving the preservation table', () => {
    const db = new Database(':memory:')

    migrate(db, allMigrations)

    expect(runColumns(db)).toEqual(expect.arrayContaining(OUTCOME_COLUMNS))
    expect(tableExists(db, PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE)).toBe(false)
  })

  it('adds the columns to a database that already applied every upstream migration', () => {
    const db = new Database(':memory:')
    migrate(
      db,
      allMigrations.filter(
        (migration) =>
          migration.id !== '202610181319-preserve-fork-schedule-outcomes' &&
          migration.id !== '202611041200-schedule-run-outcome',
      ),
    )

    migrate(db, allMigrations)

    expect(runColumns(db)).toEqual(expect.arrayContaining(OUTCOME_COLUMNS))
    expect(tableExists(db, PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE)).toBe(false)
  })

  it('orders the preservation step before the rebuild and the restore step after it', () => {
    const ids = allMigrations.map((migration) => migration.id)
    const preserve = ids.indexOf('202610181319-preserve-fork-schedule-outcomes')
    const rebuild = ids.indexOf('202610181320-remote-schedule-targets')
    const restore = ids.indexOf('202611041200-schedule-run-outcome')

    expect(preserve).toBeGreaterThan(-1)
    expect(preserve).toBeLessThan(rebuild)
    expect(restore).toBeGreaterThan(rebuild)
  })
})
