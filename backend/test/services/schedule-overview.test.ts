import { describe, expect, it, vi } from 'vitest'
import { ScheduleOverviewResponseSchema, type ScheduleRun } from '@opencode-manager/shared/schemas'
import type { ScheduleJobWithRepo } from '../../src/db/schedules'
import { buildScheduleOverview, type ScheduleOverviewInput } from '../../src/services/schedule-overview'
import { buildFireTimes, OverviewCache } from '../../src/services/overview-source'
import { buildPriceTable } from '../../src/services/stats/pricing'
import { Database } from 'bun:sqlite'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { ScheduleOverviewReader } from '../../src/services/overview-source'

const now = Date.parse('2026-03-09T03:30:00Z')
const day = 86_400_000
const job = (id = 2, overrides: Partial<ScheduleJobWithRepo> = {}): ScheduleJobWithRepo => ({
  id,
  repoId: 1,
  repoName: 'repo',
  repoPath: '/repo',
  repoUrl: '',
  name: `job ${id}`,
  description: null,
  enabled: true,
  scheduleMode: 'cron',
  cronExpression: '0 4 * * *',
  timezone: 'Asia/Seoul',
  intervalMinutes: null,
  agentSlug: 'worker',
  prompt: '',
  model: null,
  skillMetadata: null,
  permissionConfig: null,
  mcpServers: [],
  branch: null,
  workspaceMode: 'worktree',
  sandbox: null,
  serverName: null,
  lastRun: null,
  createdAt: 0,
  updatedAt: 0,
  lastRunAt: null,
  nextRunAt: null,
  ...overrides,
})
const run = (id: number, overrides: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id,
  jobId: 2,
  repoId: 1,
  triggerSource: 'schedule',
  status: 'completed',
  outcome: 'succeeded',
  startedAt: now - 1000,
  finishedAt: now,
  createdAt: now,
  sessionId: null,
  sessionTitle: null,
  logText: null,
  responseText: null,
  errorText: null,
  runBranch: null,
  commitHash: null,
  worktreePath: null,
  viewedAt: null,
  ...overrides,
})
const input = (overrides: Partial<ScheduleOverviewInput> = {}): ScheduleOverviewInput => ({
  jobs: [job()],
  runs: [],
  latest: new Map(),
  now,
  windowDays: 7,
  tz: 'Asia/Seoul',
  prices: new Map(),
  fireTimes: new Map(),
  deadlineMs: 60000,
  ...overrides,
})

describe('schedule overview', () => {
  it('returns null state for a job without runs', () => {
    const result = buildScheduleOverview(input())
    expect(result.jobs[0]).toMatchObject({
      lastRun: null,
      processed: null,
      remaining: null,
      unit: null,
      delivery: null,
      successRate: null,
      avgDurationMs: null,
      usage: null,
      agentStatus: 'unknown',
    })
    expect(Object.keys(result.totals.current.outcomes)).toHaveLength(7)
    expect(result.totals.current.estimatedCost).toBeNull()
  })

  it('aggregates valid usage and additional usage without double charging recorded cost', () => {
    const totals = { input: 100, output: 20, reasoning: 10, cacheRead: 200, cacheWrite: 40, cost: 0, messages: 2 }
    const usage = {
      computedAt: now,
      sessions: 1,
      totals,
      byModel: { 'openai/gpt': totals },
      additional: { ...totals, models: { 'other/missing': totals } },
      error: null,
    }
    const runs = [
      run(1, { usage }),
      run(2, {
        usage: {
          ...usage,
          totals: { ...totals, cost: 5 },
          byModel: { 'openai/gpt': { ...totals, cost: 5 } },
          additional: null,
        },
      }),
      run(3, { usage: { ...usage, error: 'unavailable' } }),
    ]
    const prices = buildPriceTable([
      { providerID: 'openai', modelID: 'gpt', cost: [{ input: 10, output: 50, cache: { read: 1, write: 12.5 } }] },
    ])
    const result = buildScheduleOverview(input({ runs, prices }))
    expect(result.jobs[0]?.usage).toMatchObject({
      runsWithUsage: 2,
      totals: { input: 300, output: 60, reasoning: 30, cacheRead: 600, cacheWrite: 120, cost: 5, messages: 4 },
      perRunAvgTokens: 555,
      recordedCost: 5,
      estimatedCost: 0.0032,
      unpricedRuns: 1,
    })
    expect(result.totals.current).toMatchObject({
      tokens: 1110,
      runsWithUsage: 2,
      recordedCost: 5,
      estimatedCost: 0.0032,
    })
    expect(result.series.at(-1)).toMatchObject({ tokens: 1110, estimatedCost: 0.0032 })
  })

  it.each([
    [{ errorText: 'AGENT_NOT_AVAILABLE: worker', agentUsed: 'different' }, 'unavailable'],
    [{ agentUsed: 'different' }, 'mismatch'],
    [{ agentUsed: null }, 'unknown'],
  ] as const)('derives agent status from the latest terminal run %j', (overrides, expected) => {
    const terminal = run(1, overrides)
    const result = buildScheduleOverview(
      input({
        latest: new Map([
          [2, { latest: run(2, { status: 'running' }), latestReported: null, latestTerminal: terminal }],
        ]),
      }),
    )
    expect(result.jobs[0]).toMatchObject({ agentStatus: expected, agentUsed: overrides.agentUsed })
  })

  it('merges additional model context before applying price tiers', () => {
    const tokens = { input: 150, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 }
    const usage = {
      computedAt: now,
      sessions: 1,
      totals: tokens,
      byModel: { 'provider/model': tokens },
      additional: { ...tokens, models: { 'provider/model': tokens } },
      error: null,
    }
    const prices = buildPriceTable([
      {
        providerID: 'provider',
        modelID: 'model',
        cost: [
          { input: 1, output: 0, cache: { read: 0, write: 0 } },
          { input: 3, output: 0, cache: { read: 0, write: 0 }, tier: { type: 'context', size: 200 } },
        ],
      },
    ])
    const result = buildScheduleOverview(input({ runs: [run(1, { usage })], prices }))
    expect(result.totals.current.estimatedCost).toBe(0.0009)
  })

  it('includes linked-server jobs that have no repository', () => {
    const remote = job(3, { repoId: null, repoName: 'Linked server', serverId: 'srv_1', directory: '/remote/repo' })
    const result = buildScheduleOverview(
      input({
        jobs: [remote],
        runs: [run(9, { jobId: 3, repoId: null, status: 'running', finishedAt: null, outcome: null })],
        fireTimes: new Map([[3, [now + 60_000]]]),
      }),
    )
    expect(ScheduleOverviewResponseSchema.parse(result).jobs[0]).toMatchObject({ jobId: 3, repoId: null, repoName: 'Linked server' })
    expect(result.running[0]).toMatchObject({ runId: 9, repoId: null })
    expect(result.upcoming[0]).toMatchObject({ jobId: 3, repoId: null })
  })

  it.each([1, 7, 30] as const)('uses calendar buckets for %s days', (windowDays) => {
    const result = buildScheduleOverview(input({ windowDays }))
    expect(result.series).toHaveLength(windowDays === 1 ? 24 : windowDays)
    expect(result.series.at(-1)?.label).toBe(windowDays === 1 ? '12:00' : '03.09')
    expect(ScheduleOverviewResponseSchema.safeParse(result).success).toBe(true)
  })

  it('keeps DST day boundaries at local midnight', () => {
    const result = buildScheduleOverview(input({ now: Date.parse('2026-03-10T12:00:00Z'), tz: 'America/New_York' }))
    expect(result.series.find((bucket) => bucket.label === '03.08')?.start).toBe(Date.parse('2026-03-08T05:00:00Z'))
    expect(result.series.find((bucket) => bucket.label === '03.09')?.start).toBe(Date.parse('2026-03-09T04:00:00Z'))
    for (const bucket of result.series)
      expect(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(
          bucket.start,
        ),
      ).toBe('00')
  })

  it('separates periods and calculates terminal outcomes and durations', () => {
    const runs = [
      run(1),
      run(2, { startedAt: now - 2000, outcome: 'partial' }),
      run(3, { startedAt: now - 3000, outcome: null }),
      run(4, { startedAt: now - 8 * day, finishedAt: now - 8 * day + 4000 }),
    ]
    const result = buildScheduleOverview(input({ runs }))
    expect(result.totals.current).toMatchObject({
      runs: 3,
      terminal: 3,
      successRate: 1 / 3,
      avgDurationMs: 2000,
      p90DurationMs: 3000,
      outcomes: { succeeded: 1, partial: 1, unreported: 1 },
    })
    expect(result.totals.previous.runs).toBe(1)
    expect(result.series.at(-1)?.maxConcurrent).toBe(3)
  })

  it('counts processed reports and treats touching run endpoints as nonconcurrent', () => {
    const report = {
      outcome: 'succeeded',
      summary: 'done',
      processed: 4,
      reportedAt: now,
      agent: null,
      reportCount: 1,
    } as const
    const runs = [
      run(1, { startedAt: now - 2000, finishedAt: now - 1000, outcomeReport: report }),
      run(2, { outcomeReport: report }),
    ]
    const result = buildScheduleOverview(input({ runs }))
    expect(result.totals.current.processed).toBe(8)
    expect(result.series.at(-1)).toMatchObject({ maxConcurrent: 1, processed: 8 })
  })

  it('preserves old reported state independently of window aggregation', () => {
    const old = run(1, {
      startedAt: now - 8 * day,
      agentUsed: 'worker',
      outcomeReport: {
        outcome: 'succeeded',
        summary: 'finished',
        processed: 8,
        remaining: 2,
        unit: 'items',
        delivery: 'published',
        reportedAt: now - 8 * day,
        agent: 'worker',
        reportCount: 1,
      },
    })
    const result = buildScheduleOverview(
      input({ latest: new Map([[2, { latest: old, latestReported: old, latestTerminal: old }]]) }),
    )
    expect(result.jobs[0]).toMatchObject({
      runs: 0,
      processed: 8,
      remaining: 2,
      agentStatus: 'ok',
      lastRun: { id: 1, summary: 'finished' },
      successRate: null,
      avgDurationMs: null,
      usage: null,
    })
  })

  it('includes old running runs and uses the median of three successes', () => {
    const runs = [
      run(1),
      run(2, { startedAt: now - 9000 }),
      run(3, { startedAt: now - 3000 }),
      run(4, { status: 'running', outcome: null, startedAt: now - 90 * day, finishedAt: null }),
    ]
    const result = buildScheduleOverview(input({ runs }))
    expect(result.running[0]).toMatchObject({ runId: 4, deadlineAt: now - 90 * day + 60000, typicalDurationMs: 3000 })
    expect(result.series[0]?.maxConcurrent).toBe(1)
    expect(buildScheduleOverview(input({ runs: runs.slice(1) })).running[0]?.typicalDurationMs).toBeNull()
  })

  it('caps recent runs and orders upcoming runs', () => {
    const result = buildScheduleOverview(
      input({
        runs: Array.from({ length: 25 }, (_, index) => run(index, { startedAt: now - index - 1 })),
        fireTimes: new Map([[2, Array.from({ length: 10 }, (_, index) => now + (10 - index) * 60000)]]),
      }),
    )
    expect(result.jobs[0]?.recentRuns).toHaveLength(20)
    expect(result.jobs[0]?.recentRuns[0]?.runId).toBe(0)
    expect(result.upcoming.map((fire) => fire.at)).toEqual(
      Array.from({ length: 8 }, (_, index) => now + (index + 1) * 60000),
    )
  })

  it('detects daily and Monday overlap and removes it after moving the daily job', () => {
    const monday = job(6, { cronExpression: '0 4 * * 1' })
    const from = Date.parse('2026-03-08T00:00:00Z')
    const jobs = [job(), monday]
    expect(
      buildScheduleOverview(input({ jobs, now: from, fireTimes: buildFireTimes(jobs, from) })).jobs[0]?.overlaps[0]
        ?.jobId,
    ).toBe(6)
    const moved = [job(2, { cronExpression: '0 5 * * *' }), monday]
    expect(
      buildScheduleOverview(input({ jobs: moved, now: from, fireTimes: buildFireTimes(moved, from) })).jobs[0]
        ?.overlaps,
    ).toEqual([])
  })

  it('finds a five-minute cron overlap two days into the forecast', () => {
    const jobs = [
      job(2, { cronExpression: '*/5 * * * *' }),
      job(6, { scheduleMode: 'interval', intervalMinutes: 10080, nextRunAt: now + 2 * day }),
    ]
    const result = buildScheduleOverview(input({ jobs, fireTimes: buildFireTimes(jobs, now) }))
    expect(result.jobs[1]?.overlaps[0]).toMatchObject({ jobId: 2, at: now + 2 * day })
  })

  it('sweeps two minute-level forecasts in less than one second', () => {
    const jobs = [job(2), job(6)]
    const times = Array.from({ length: 10080 }, (_, index) => now + index * 60000)
    const started = performance.now()
    const result = buildScheduleOverview(
      input({
        jobs,
        fireTimes: new Map([
          [2, times],
          [6, times],
        ]),
      }),
    )
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.jobs.map((item) => item.overlaps.length)).toEqual([1, 1])
  })

  it('shares in-flight work and caches results for fifteen seconds per key', async () => {
    const cache = new OverviewCache()
    const load = vi.fn(async () => buildScheduleOverview(input()))
    const first = cache.get('7:Asia/Seoul', now, load)
    expect(cache.get('7:Asia/Seoul', now, load)).toBe(first)
    await first
    await cache.get('7:Asia/Seoul', now + 14999, load)
    expect(load).toHaveBeenCalledTimes(1)
    await cache.get('7:Asia/Seoul', now + 15000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reads persistent latest state and old running runs once for shared requests', async () => {
    const db = new Database(':memory:')
    migrate(db, allMigrations)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      db.exec(
        `INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at) VALUES (1, '', 'repos/repo', 'main', 'main', 'ready', 0)`,
      )
      db.exec(
        `INSERT INTO schedule_jobs (id, repo_id, name, enabled, schedule_mode, interval_minutes, agent_slug, prompt, created_at, updated_at) VALUES (2, 1, 'Job', 1, 'interval', 60, 'worker', '', 0, 0)`,
      )
      const old = run(1, {
        startedAt: now - 8 * day,
        outcomeReport: {
          outcome: 'succeeded',
          summary: 'old report',
          processed: 9,
          remaining: 1,
          reportedAt: now - 8 * day,
          agent: 'worker',
          reportCount: 1,
        },
      })
      db.prepare(
        `INSERT INTO schedule_runs (id, job_id, repo_id, trigger_source, status, started_at, created_at, finished_at, outcome, outcome_json, agent_used) VALUES (1, 2, 1, 'schedule', 'completed', ?, ?, ?, 'succeeded', ?, 'worker')`,
      ).run(old.startedAt, old.startedAt, old.startedAt + 1000, JSON.stringify(old.outcomeReport))
      db.prepare(
        `INSERT INTO schedule_runs (id, job_id, repo_id, trigger_source, status, started_at, created_at) VALUES (2, 2, 1, 'schedule', 'running', ?, ?)`,
      ).run(now - 90 * day, now - 90 * day)
      const prepare = vi.spyOn(db, 'prepare')
      const reader = new ScheduleOverviewReader(db, { getPrices: async () => new Map() })
      const first = reader.get(7, 'Asia/Seoul')
      expect(reader.get(7, 'Asia/Seoul')).toBe(first)
      const result = await first
      expect(result.jobs[0]).toMatchObject({
        runs: 0,
        processed: 9,
        remaining: 1,
        agentStatus: 'ok',
        lastRun: { id: 1 },
      })
      expect(result.running[0]?.runId).toBe(2)
      expect(await reader.get(7, 'Asia/Seoul')).toBe(result)
      expect(prepare).toHaveBeenCalledTimes(3)
      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes("WHERE started_at >= ? OR status = 'running'")),
      ).toHaveLength(1)
    } finally {
      clock.mockRestore()
      db.close()
    }
  })
})
