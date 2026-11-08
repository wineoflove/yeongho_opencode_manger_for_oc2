import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import type { ScheduleOutcomeReport, ScheduleRunUsage } from '@opencode-manager/shared/schemas'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { getScheduleRunById, updateScheduleRunUsage } from '../../src/db/schedules'

const totals = {
  input: 100,
  output: 20,
  reasoning: 5,
  cacheRead: 30,
  cacheWrite: 10,
  cost: 0.25,
  messages: 2,
}
const additional = {
  input: 10,
  output: 2,
  reasoning: 1,
  cacheRead: 3,
  cacheWrite: 0,
  cost: 0.05,
}
const usage: ScheduleRunUsage = {
  computedAt: 3000,
  sessions: 2,
  totals,
  byModel: { 'provider/model': totals },
  additional: { ...additional, models: { 'provider/extra': additional } },
  error: 'One session was unavailable',
}
const report: ScheduleOutcomeReport = {
  outcome: 'partial',
  summary: 'Published one report',
  processed: 1,
  remaining: 1,
  unit: 'report',
  delivery: 'published',
  artifacts: ['reports/daily.md'],
  additionalUsage: additional,
  reportedAt: 1500,
  agent: 'reporter',
  reportCount: 2,
}

describe('updateScheduleRunUsage', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    db.exec(`
      INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
      VALUES (1, 'https://github.com/test/repo', 'repos/repo', 'main', 'main', 'ready', 1000);
      INSERT INTO schedule_jobs (id, repo_id, server_id, name, enabled, schedule_mode, prompt, created_at, updated_at)
      VALUES (3, 1, 'local', 'Daily review', 1, 'interval', 'Review', 1000, 1000),
             (4, NULL, 'remote', 'Remote review', 1, 'interval', 'Review', 1000, 1000);
    `)
  })

  afterEach(() => db.close())

  function seedRun(repoId: number | null, status: string) {
    const run = { id: 10, repoId, jobId: repoId === null ? 4 : 3 }
    db.prepare(
      `
      INSERT INTO schedule_runs (
        id, job_id, repo_id, server_id, trigger_source, status, started_at, created_at, finished_at,
        session_id, session_title, log_text, response_text, error_text, viewed_at,
        run_branch, commit_hash, worktree_path, outcome, outcome_json, usage_json, agent_used
      ) VALUES (?, ?, ?, ?, 'schedule', ?, 1000, 1000, 2000,
        'ses_run', 'Daily report', 'Run log', 'Report body', 'Run error', 2500,
        'schedule/run', 'abc123', '/worktree/run', 'partial', ?, ?, 'original-agent')
    `,
    ).run(
      run.id,
      run.jobId,
      repoId,
      repoId === null ? 'remote' : 'local',
      status,
      JSON.stringify(report),
      JSON.stringify({ ...usage, computedAt: 1000 }),
    )
    return run
  }

  it.each([
    { status: 'completed', repoId: 1 },
    { status: 'failed', repoId: 1 },
    { status: 'cancelled', repoId: 1 },
    { status: 'completed', repoId: null },
    { status: 'failed', repoId: null },
    { status: 'cancelled', repoId: null },
  ])('roundtrips $status usage for repo $repoId without changing other columns', ({ status, repoId }) => {
    const run = seedRun(repoId, status)
    const before = db.prepare<Record<string, unknown>, [number]>('SELECT * FROM schedule_runs WHERE id = ?').get(run.id)
    const beforeRun = getScheduleRunById(db, repoId, run.jobId, run.id)

    expect(updateScheduleRunUsage(db, run, { usage, agentUsed: 'usage-agent' })).toBe(true)

    expect(getScheduleRunById(db, repoId, run.jobId, run.id)).toEqual({
      ...beforeRun,
      usage,
      agentUsed: 'usage-agent',
    })
    expect(db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(run.id)).toEqual({
      ...before,
      usage_json: JSON.stringify(usage),
      agent_used: 'usage-agent',
    })
  })

  it.each([
    {
      name: 'running',
      status: 'running',
      repoId: 1,
      scope: { id: 10, repoId: 1, jobId: 3 },
    },
    {
      name: 'missing',
      status: 'completed',
      repoId: 1,
      scope: { id: 99, repoId: 1, jobId: 3 },
    },
    {
      name: 'wrong repo',
      status: 'completed',
      repoId: 1,
      scope: { id: 10, repoId: 2, jobId: 3 },
    },
    {
      name: 'wrong job',
      status: 'completed',
      repoId: 1,
      scope: { id: 10, repoId: 1, jobId: 4 },
    },
    {
      name: 'null repo mismatch',
      status: 'completed',
      repoId: 1,
      scope: { id: 10, repoId: null, jobId: 3 },
    },
    {
      name: 'remote repo mismatch',
      status: 'completed',
      repoId: null,
      scope: { id: 10, repoId: 1, jobId: 4 },
    },
    {
      name: 'remote wrong job',
      status: 'completed',
      repoId: null,
      scope: { id: 10, repoId: null, jobId: 3 },
    },
  ])('rejects $name without changing rows', ({ status, repoId, scope }) => {
    seedRun(repoId, status)
    const before = db.prepare('SELECT * FROM schedule_runs').all()

    expect(updateScheduleRunUsage(db, scope, { usage, agentUsed: 'replacement' })).toBe(false)

    expect(db.prepare('SELECT * FROM schedule_runs').all()).toEqual(before)
  })

  it.each(['original-agent', null])('preserves existing agent %s when incoming agent is null', (agent) => {
    const run = seedRun(1, 'completed')
    db.prepare('UPDATE schedule_runs SET agent_used = ? WHERE id = ?').run(agent, run.id)

    expect(updateScheduleRunUsage(db, run, { usage, agentUsed: null })).toBe(true)

    expect(getScheduleRunById(db, run.repoId, run.jobId, run.id)).toMatchObject({ usage, agentUsed: agent })
  })

  it.each([
    { ...usage, sessions: -1 },
    { ...usage, totals: { ...totals, cost: Number.NaN } },
    { ...usage, byModel: { 'provider/model': { ...totals, input: 1.5 } } },
    { ...usage, error: 'x'.repeat(301) },
  ])('rejects malformed usage before modifying the row', (invalidUsage) => {
    const run = seedRun(1, 'completed')
    const before = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(run.id)

    expect(() =>
      updateScheduleRunUsage(db, run, {
        usage: invalidUsage,
        agentUsed: 'replacement',
      }),
    ).toThrow()

    expect(db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(run.id)).toEqual(before)
  })
})
