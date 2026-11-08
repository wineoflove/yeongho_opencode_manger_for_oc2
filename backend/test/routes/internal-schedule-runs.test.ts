import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { allMigrations } from '../../src/db/migrations'
import { migrate } from '../../src/db/migration-runner'
import { getScheduleRunById, updateScheduleRun } from '../../src/db/schedules'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { ScheduleService } from '../../src/services/schedules'
import type { ScheduleWorktreeManager } from '../../src/services/schedule-worktree'
import { createStubOpenCodeClient } from '../helpers/stub-opencode-client'
import { createInternalTestApp } from '../helpers/internal-test-app'

const REPO_ID = 1
const JOB_ID = 3

function seedRun(db: Database, runId: number, sessionId: string, status = 'running') {
  db.prepare(
    `INSERT INTO schedule_runs (id, job_id, repo_id, server_id, trigger_source, status, started_at, created_at, session_id)
     VALUES (?, ?, ?, 'local', 'schedule', ?, ?, ?, ?)`,
  ).run(runId, JOB_ID, REPO_ID, status, Date.now(), Date.now(), sessionId)
}

describe('internal/schedule-runs routes', () => {
  let db: Database
  let app: Hono
  let token: string

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    const now = Date.now()
    db.exec(
      `INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
       VALUES (${REPO_ID}, 'https://github.com/test/repo', 'repos/repo', 'main', 'main', 'ready', ${now})`,
    )
    db.prepare(
      `INSERT INTO schedule_jobs (id, repo_id, server_id, name, enabled, schedule_mode, prompt, created_at, updated_at)
       VALUES (?, ?, 'local', 'Daily review', 1, 'interval', 'Review', ?, ?)`,
    ).run(JOB_ID, REPO_ID, now, now)
    const stubWorktreeManager = {
      prepare: () => Promise.resolve(null),
      finalize: () => Promise.resolve({ commitHash: null }),
    } as unknown as ScheduleWorktreeManager
    const scheduleService = new ScheduleService(db, createStubOpenCodeClient(), stubWorktreeManager)
    app = new Hono()
    app.route('/api/internal', createInternalTestApp(db, { scheduleService }))
    token = getOrCreateInternalToken(db)
  })

  function report(body: unknown, auth = true) {
    return app.request('/api/internal/schedule-runs/outcome', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    })
  }

  it('returns 401 without the internal token', async () => {
    seedRun(db, 10, 'ses_sched1')
    const res = await report({ outcome: 'succeeded', summary: 'done', sessionID: 'ses_sched1' }, false)
    expect(res.status).toBe(401)
  })

  it('records the reported outcome on the running run of the session', async () => {
    seedRun(db, 10, 'ses_sched1')

    const res = await report({
      outcome: 'partial',
      summary: '2건 중 1건 게시',
      processed: 1,
      remaining: 1,
      unit: 'report',
      delivery: 'published',
      sessionID: 'ses_sched1',
      agent: 'assistant',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runId: 10, jobId: JOB_ID, outcome: 'partial' })
    const run = getScheduleRunById(db, REPO_ID, JOB_ID, 10)
    expect(run?.outcome).toBe('partial')
    expect(run?.outcomeReport).toMatchObject({
      outcome: 'partial',
      summary: '2건 중 1건 게시',
      processed: 1,
      remaining: 1,
      unit: 'report',
      delivery: 'published',
      agent: 'assistant',
      reportCount: 1,
    })
  })

  it('replaces an earlier report and counts how many reports arrived', async () => {
    seedRun(db, 10, 'ses_sched1')
    await report({ outcome: 'failed', summary: 'first', sessionID: 'ses_sched1' })

    const res = await report({ outcome: 'succeeded', summary: 'second', sessionID: 'ses_sched1', agent: null })

    expect(res.status).toBe(200)
    const run = getScheduleRunById(db, REPO_ID, JOB_ID, 10)
    expect(run?.outcome).toBe('succeeded')
    expect(run?.outcomeReport).toMatchObject({ summary: 'second', agent: null, reportCount: 2 })
  })

  it('returns 404 when no running scheduled run is linked to the session', async () => {
    seedRun(db, 10, 'ses_done', 'completed')

    const res = await report({ outcome: 'succeeded', summary: 'late', sessionID: 'ses_done' })

    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('OCM_OUTCOME_NO_RUNNING_RUN') })
    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 10)?.outcomeReport).toBeNull()
  })

  it('rejects outcomes the agent may not report and malformed session ids', async () => {
    seedRun(db, 10, 'ses_sched1')

    const unreported = await report({ outcome: 'unreported', summary: 'x', sessionID: 'ses_sched1' })
    const missingSummary = await report({ outcome: 'succeeded', sessionID: 'ses_sched1' })
    const badSession = await report({ outcome: 'succeeded', summary: 'x', sessionID: '../etc' })

    expect(unreported.status).toBe(400)
    expect(missingSummary.status).toBe(400)
    expect(badSession.status).toBe(400)
    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 10)?.outcome).toBeNull()
  })

  it('derives the outcome when a run finishes without a report and keeps a reported one', () => {
    seedRun(db, 10, 'ses_a')
    seedRun(db, 11, 'ses_b')
    seedRun(db, 12, 'ses_c')
    seedRun(db, 13, 'ses_d')
    db.prepare(
      `UPDATE schedule_runs SET outcome = 'succeeded', outcome_json = '{"outcome":"succeeded","summary":"ok","reportedAt":1,"agent":null,"reportCount":1}' WHERE id = 13`,
    ).run()
    const finishedAt = Date.now()

    updateScheduleRun(db, REPO_ID, JOB_ID, 10, { status: 'completed', finishedAt })
    updateScheduleRun(db, REPO_ID, JOB_ID, 11, { status: 'failed', finishedAt })
    updateScheduleRun(db, REPO_ID, JOB_ID, 12, { status: 'cancelled', finishedAt })
    updateScheduleRun(db, REPO_ID, JOB_ID, 13, { status: 'failed', finishedAt })

    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 10)?.outcome).toBe('unreported')
    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 11)?.outcome).toBe('failed')
    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 12)?.outcome).toBe('cancelled')
    expect(getScheduleRunById(db, REPO_ID, JOB_ID, 13)?.outcome).toBe('succeeded')
  })
})
