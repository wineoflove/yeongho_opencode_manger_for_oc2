import type { ScheduleOverviewResponse, ScheduleOverviewJob, ScheduleRun } from '@opencode-manager/shared/schemas'
import type { LatestScheduleRunsForJob, ScheduleJobWithRepo } from '../db/schedules'
import type { PriceTable } from './stats/pricing'
import { buildOverviewWindow, OVERVIEW_DAY_MS, type OverviewWindowDays } from './overview-window'
import { aggregateRuns, aggregateUsage, maxConcurrent } from './overview-aggregate'
import { buildOverlaps } from './overview-overlaps'

export { startOfLocalDay, startOfLocalHour } from './overview-window'

export interface ScheduleOverviewInput {
  readonly jobs: readonly ScheduleJobWithRepo[]
  readonly runs: readonly ScheduleRun[]
  readonly latest: ReadonlyMap<number, LatestScheduleRunsForJob>
  readonly now: number
  readonly windowDays: OverviewWindowDays
  readonly tz: string
  readonly prices: PriceTable
  readonly fireTimes: ReadonlyMap<number, readonly number[]>
  readonly deadlineMs: number
}

function agentStatus(
  job: ScheduleJobWithRepo,
  terminal: ScheduleRun | null | undefined,
): ScheduleOverviewJob['agentStatus'] {
  if (terminal?.errorText?.startsWith('AGENT_NOT_AVAILABLE')) return 'unavailable'
  if (job.agentSlug && terminal?.agentUsed && job.agentSlug !== terminal.agentUsed) return 'mismatch'
  return terminal?.agentUsed ? 'ok' : 'unknown'
}

export function buildScheduleOverview(input: ScheduleOverviewInput): ScheduleOverviewResponse {
  const { now, windowDays, tz, prices, runs, latest, fireTimes, deadlineMs } = input
  const { window, previousWindow, buckets } = buildOverviewWindow(now, windowDays, tz)
  const current = runs.filter((run) => run.startedAt >= window.from && run.startedAt <= now)
  const previous = runs.filter((run) => run.startedAt >= previousWindow.from && run.startedAt < previousWindow.to)
  const jobs: ScheduleOverviewJob[] = input.jobs.map((job) => {
    const jobRuns = current.filter((run) => run.jobId === job.id)
    const totals = aggregateRuns(jobRuns, prices)
    const state = latest.get(job.id)
    const last = state?.latest
    const report = state?.latestReported?.outcomeReport
    return {
      jobId: job.id,
      repoId: job.repoId,
      serverId: job.serverId ?? 'local',
      directory: job.directory ?? null,
      repoName: job.repoName,
      name: job.name,
      enabled: job.enabled,
      scheduleLabel:
        job.scheduleMode === 'cron' ? `${job.cronExpression} (${job.timezone})` : `every ${job.intervalMinutes} min`,
      timezone: job.timezone,
      nextRunAt: job.nextRunAt,
      agentSlug: job.agentSlug,
      agentStatus: agentStatus(job, state?.latestTerminal),
      agentUsed: state?.latestTerminal?.agentUsed ?? null,
      lastRun: last
        ? {
            id: last.id,
            status: last.status,
            outcome: last.outcome ?? null,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            summary: last.outcomeReport?.summary ?? null,
          }
        : null,
      runs: totals.runs,
      outcomes: totals.outcomes,
      successRate: totals.successRate,
      avgDurationMs: totals.avgDurationMs,
      p90DurationMs: totals.p90DurationMs,
      processed: report?.processed ?? null,
      remaining: report?.remaining ?? null,
      unit: report?.unit ?? null,
      delivery: report?.delivery ?? null,
      usage: aggregateUsage(jobRuns, prices),
      overlaps: [],
      recentRuns: [...jobRuns]
        .sort((left, right) => right.startedAt - left.startedAt || right.id - left.id)
        .slice(0, 20)
        .map((run) => ({
          runId: run.id,
          startedAt: run.startedAt,
          status: run.status,
          outcome: run.outcome ?? null,
          durationMs: run.finishedAt === null ? null : run.finishedAt - run.startedAt,
        })),
    }
  })
  const overlaps = buildOverlaps(jobs, fireTimes)
  const byId = new Map(input.jobs.map((job) => [job.id, job]))
  const running = runs
    .filter((run) => run.status === 'running')
    .sort((left, right) => left.startedAt - right.startedAt)
    .flatMap((run) => {
      const job = byId.get(run.jobId)
      if (!job) return []
      const durations = runs
        .filter(
          (candidate) =>
            candidate.jobId === job.id &&
            candidate.outcome === 'succeeded' &&
            candidate.finishedAt !== null &&
            candidate.startedAt >= now - 30 * OVERVIEW_DAY_MS &&
            candidate.startedAt <= now,
        )
        .map((candidate) => (candidate.finishedAt ?? candidate.startedAt) - candidate.startedAt)
        .sort((left, right) => left - right)
      const middle = Math.floor(durations.length / 2)
      const median =
        durations.length % 2
          ? (durations[middle] ?? null)
          : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2
      return [
        {
          runId: run.id,
          jobId: run.jobId,
          repoId: run.repoId,
          serverId: job.serverId ?? 'local',
          directory: job.directory ?? null,
          jobName: job.name,
          repoName: job.repoName,
          agentSlug: job.agentSlug,
          startedAt: run.startedAt,
          sessionId: run.sessionId,
          deadlineAt: run.startedAt + deadlineMs,
          typicalDurationMs: durations.length >= 3 ? median : null,
        },
      ]
    })
  return {
    generatedAt: now,
    windowDays,
    tz,
    enabledJobs: input.jobs.filter((job) => job.enabled).length,
    totalJobs: input.jobs.length,
    window,
    previousWindow,
    totals: { current: aggregateRuns(current, prices), previous: aggregateRuns(previous, prices) },
    series: buckets.map((bucket, index) => {
      const totals = aggregateRuns(
        current.filter(
          (run) =>
            run.startedAt >= bucket.start &&
            (run.startedAt < bucket.to || (index === buckets.length - 1 && run.startedAt === now)),
        ),
        prices,
      )
      return {
        start: bucket.start,
        label: bucket.label,
        runs: totals.runs,
        outcomes: totals.outcomes,
        avgDurationMs: totals.avgDurationMs,
        processed: totals.processed,
        tokens: totals.tokens,
        estimatedCost: totals.estimatedCost,
        maxConcurrent: maxConcurrent(runs, { from: bucket.start, to: bucket.to }, now),
      }
    }),
    running,
    upcoming: input.jobs
      .filter((job) => job.enabled)
      .flatMap((job) =>
        (fireTimes.get(job.id) ?? []).map((at) => ({
          jobId: job.id,
          repoId: job.repoId,
          serverId: job.serverId ?? 'local',
          directory: job.directory ?? null,
          name: job.name,
          at,
          kind: job.scheduleMode,
        })),
      )
      .sort((left, right) => left.at - right.at || left.jobId - right.jobId)
      .slice(0, 8),
    jobs: jobs.map((job) => ({ ...job, overlaps: overlaps.get(job.jobId) ?? [] })),
  }
}
