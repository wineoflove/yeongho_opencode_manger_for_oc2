import type { Database } from 'bun:sqlite'
import { Cron } from 'croner'
import type { ScheduleJob, ScheduleOverviewResponse } from '@opencode-manager/shared/schemas'
import {
  listAllScheduleJobsWithRepos,
  listLatestScheduleRunsPerJob,
  listScheduleRunsForOverview,
} from '../db/schedules'
import { logger } from '../utils/logger'
import type { ModelPriceCache } from './stats/pricing'
import { buildScheduleOverview } from './schedule-overview'
import { buildOverviewWindow, OVERVIEW_DAY_MS, type OverviewWindowDays } from './overview-window'
import { getRunDeadlineMs } from './schedule-run-deadline'

export function buildFireTimes(jobs: readonly ScheduleJob[], from: number): Map<number, number[]> {
  const to = from + 7 * OVERVIEW_DAY_MS
  const result = new Map<number, number[]>()
  for (const job of jobs) {
    if (!job.enabled) continue
    const times: number[] = []
    switch (job.scheduleMode) {
      case 'cron': {
        if (!job.cronExpression) break
        const cron = new Cron(job.cronExpression, { timezone: job.timezone ?? undefined })
        let next = cron.nextRun(new Date(from))
        while (next && next.getTime() < to && times.length < 10080) {
          times.push(next.getTime())
          next = cron.nextRun(next)
        }
        if (times.length === 10080) logger.warn('Schedule overview forecast reached interval cap', { jobId: job.id })
        break
      }
      case 'interval': {
        if (job.nextRunAt === null || job.intervalMinutes === null) break
        const step = job.intervalMinutes * 60000
        const first = job.nextRunAt + Math.max(0, Math.ceil((from - job.nextRunAt) / step)) * step
        for (let at = first; at < to; at += step) times.push(at)
        break
      }
      default: {
        const exhaustive: never = job.scheduleMode
        return exhaustive
      }
    }
    result.set(job.id, times)
  }
  return result
}

export class OverviewCache {
  private readonly entries = new Map<
    string,
    { readonly until: number; readonly promise: Promise<ScheduleOverviewResponse>; pending: boolean }
  >()

  get(key: string, now: number, load: () => Promise<ScheduleOverviewResponse>): Promise<ScheduleOverviewResponse> {
    const cached = this.entries.get(key)
    if (cached && (cached.pending || now < cached.until)) return cached.promise
    const promise = this.load(key, load)
    this.entries.set(key, { until: now + 15000, promise, pending: true })
    return promise
  }

  private async load(key: string, loader: () => Promise<ScheduleOverviewResponse>): Promise<ScheduleOverviewResponse> {
    try {
      return await loader()
    } catch (error) {
      this.entries.delete(key)
      throw error
    } finally {
      const entry = this.entries.get(key)
      if (entry) entry.pending = false
    }
  }
}

export class ScheduleOverviewReader {
  private readonly cache = new OverviewCache()

  constructor(
    private readonly db: Database,
    private readonly prices: Pick<ModelPriceCache, 'getPrices'>,
  ) {}

  get(windowDays: OverviewWindowDays, tz: string): Promise<ScheduleOverviewResponse> {
    const now = Date.now()
    return this.cache.get(`${windowDays}:${tz}`, now, async () => {
      const { previousWindow } = buildOverviewWindow(now, windowDays, tz)
      const jobs = listAllScheduleJobsWithRepos(this.db)
      const runs = listScheduleRunsForOverview(this.db, Math.min(previousWindow.from, now - 30 * OVERVIEW_DAY_MS))
      const latest = listLatestScheduleRunsPerJob(this.db)
      const prices = await this.prices.getPrices()
      return buildScheduleOverview({
        jobs,
        runs,
        latest,
        now,
        windowDays,
        tz,
        prices,
        fireTimes: buildFireTimes(jobs, now),
        deadlineMs: getRunDeadlineMs(),
      })
    })
  }
}
