import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import type { ScheduleOutcomeReport, ScheduleRunUsage } from '@opencode-manager/shared/schemas'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { getScheduleRunById, listAllScheduleRuns, listScheduleRunsByJob } from '../../src/db/schedules'

describe('schedule run list metadata', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
  })

  afterEach(() => db.close())

  it('preserves detail and global-list metadata in per-job lists while omitting log and response bodies', () => {
    const report: ScheduleOutcomeReport = {
      outcome: 'succeeded',
      summary: 'Published daily report',
      delivery: 'published',
      reportedAt: 2000,
      agent: 'reporter',
      reportCount: 1,
    }
    const totals = {
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 30,
      cacheWrite: 10,
      cost: 0.25,
      messages: 2,
    }
    const usage: ScheduleRunUsage = {
      computedAt: 3000,
      sessions: 1,
      totals,
      byModel: { 'provider/model': totals },
      additional: null,
      error: null,
    }
    db.exec(`
      INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
      VALUES (1, 'https://github.com/test/repo', 'repos/repo', 'main', 'main', 'ready', 1000);
      INSERT INTO schedule_jobs (id, repo_id, server_id, name, enabled, schedule_mode, prompt, created_at, updated_at)
      VALUES (3, 1, 'local', 'Daily review', 1, 'interval', 'Review', 1000, 1000);
    `)
    db.prepare(
      `
      INSERT INTO schedule_runs (
        id, job_id, repo_id, server_id, trigger_source, status, started_at, created_at, finished_at,
        log_text, response_text, outcome, outcome_json, usage_json, agent_used
      ) VALUES (10, 3, 1, 'local', 'schedule', 'completed', 1000, 1000, 2000,
        'Run log', 'Report body', ?, ?, ?, 'reporter')
    `,
    ).run(report.outcome, JSON.stringify(report), JSON.stringify(usage))

    const detail = getScheduleRunById(db, 1, 3, 10)
    const globalRuns = listAllScheduleRuns(db, { runId: 10 })
    const jobRuns = listScheduleRunsByJob(db, 1, 3)

    const metadata = {
      outcome: report.outcome,
      outcomeReport: report,
      usage,
      agentUsed: 'reporter',
    }
    expect(detail).toMatchObject({
      ...metadata,
      logText: 'Run log',
      responseText: 'Report body',
    })
    expect(globalRuns).toMatchObject([{ id: 10, ...metadata, logText: null, responseText: null }])
    expect(jobRuns).toMatchObject([{ id: 10, logText: null, responseText: null }])
    expect(jobRuns).toEqual([{ ...detail, logText: null, responseText: null }])
  })
})
