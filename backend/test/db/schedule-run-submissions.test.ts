import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { scheduleRunSubmissionsMigration } from '../../src/db/migrations/202611061545-schedule-run-submissions'

describe('schedule submission persistence migration', () => {
  let db: Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    migrate(
      db,
      allMigrations.filter((migration) => migration.id !== scheduleRunSubmissionsMigration.id),
    )
    db.exec(`
      INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
      VALUES (1, 'https://example.com/repo', 'repos/fixture', 'main', 'main', 'ready', 1);
      INSERT INTO schedule_jobs (id, repo_id, server_id, name, enabled, schedule_mode, prompt, created_at, updated_at)
      VALUES (1, 1, 'local', 'Fixture', 0, 'interval', 'Review', 1, 1);
      INSERT INTO schedule_runs (id, job_id, repo_id, server_id, trigger_source, status, started_at, created_at, outcome_json, usage_json)
      VALUES (1, 1, 1, 'local', 'manual', 'running', 1, 1, '{"summary":"preserve"}', '{"cost":12}');
    `)
  })
  afterEach(() => db.close())

  it('preserves existing run bytes and submission identity across repeat migration', () => {
    const original = db.prepare('SELECT * FROM schedule_runs WHERE id = 1').get()
    migrate(db, allMigrations)
    db.prepare(`INSERT INTO schedule_run_submissions VALUES (?, ?, ?, 'pending', ?, NULL)`).run(
      1,
      'ses-fixture',
      'msg-fixture',
      2,
    )
    scheduleRunSubmissionsMigration.up(db)
    expect(db.prepare('SELECT * FROM schedule_runs WHERE id = 1').get()).toEqual(original)
    expect(db.prepare('SELECT * FROM schedule_run_submissions').all()).toEqual([
      {
        run_id: 1,
        session_id: 'ses-fixture',
        message_id: 'msg-fixture',
        state: 'pending',
        created_at: 2,
        acknowledged_at: null,
      },
    ])
    db.prepare("UPDATE schedule_run_submissions SET state = 'acknowledged', acknowledged_at = 3 WHERE run_id = 1").run()
    expect(db.prepare('SELECT state, acknowledged_at FROM schedule_run_submissions WHERE run_id = 1').get()).toEqual({
      state: 'acknowledged',
      acknowledged_at: 3,
    })
  })

  it('rejects contradictory acknowledgement state and removes only the deleted run submission', () => {
    migrate(db, allMigrations)
    expect(() =>
      db
        .prepare(
          "INSERT INTO schedule_run_submissions VALUES (1, 'ses-fixture', 'msg-fixture', 'acknowledged', 2, NULL)",
        )
        .run(),
    ).toThrow()
    expect(() =>
      db
        .prepare("INSERT INTO schedule_run_submissions VALUES (999, 'ses-missing', 'msg-missing', 'pending', 2, NULL)")
        .run(),
    ).toThrow()
    db.prepare(
      "INSERT INTO schedule_run_submissions VALUES (1, 'ses-fixture', 'msg-fixture', 'pending', 2, NULL)",
    ).run()
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    expect(db.prepare('SELECT * FROM schedule_run_submissions').all()).toEqual([])
    expect(db.prepare('SELECT id FROM schedule_jobs').all()).toEqual([{ id: 1 }])
  })
})
