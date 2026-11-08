import type { ScheduleOverviewJob, ScheduleOverviewTotals } from '@opencode-manager/shared/schemas'
import { formatCompactDuration } from '@/i18n/format'
import { t } from '@/i18n/translate'
import { getPathWithReturnTo, getServerProjectPath, getServerSessionPath, getSessionPath } from './navigation'

export function formatDuration(value: number | null): string {
  return value === null ? t('Not tracked') : formatCompactDuration(value)
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${String(minutes).padStart(2, '0')}:${remainder}`
}

export function failureCount(outcomes: ScheduleOverviewTotals['outcomes']): number {
  return outcomes.failed + outcomes.blocked
}

export function aggregateRemaining(jobs: readonly Pick<ScheduleOverviewJob, 'remaining' | 'unit'>[]) {
  const reporting = jobs.filter((job) => job.remaining !== null)
  const units = new Set(reporting.map((job) => job.unit))
  return {
    remaining: reporting.length ? reporting.reduce((sum, job) => sum + (job.remaining ?? 0), 0) : null,
    count: reporting.length,
    unit: units.size === 1 ? reporting[0].unit : null,
  }
}

export function bucketTicks(count: number, max = 8): number[] {
  const size = Math.min(count, max)
  if (size <= 0) return []
  if (size === 1) return [0]
  return Array.from({ length: size }, (_, index) => Math.round((index * (count - 1)) / (size - 1)))
}

/** Location of a scheduled job or run; linked-server jobs have no repository and open their server project. */
export interface ScheduleTarget {
  readonly repoId: number | null
  readonly serverId: string
  readonly directory: string | null
}

/** Opens a job's detail, or one run when `runId` is given; linked-server jobs open their server project. */
export function scheduleDetailPath({
  repoId,
  serverId,
  directory,
  jobId,
  runId,
  returnTo,
}: ScheduleTarget & {
  readonly jobId: number
  readonly runId?: number
  readonly returnTo: string
}): string {
  if (repoId === null) return directory ? getServerProjectPath(serverId, directory) : '/schedules'
  const params = new URLSearchParams({ jobId: String(jobId), scheduleTab: runId === undefined ? 'detail' : 'runs' })
  if (runId !== undefined) params.set('runId', String(runId))
  return getPathWithReturnTo(`/repos/${repoId}/schedules?${params}`, returnTo)
}

/** Session route for a scheduled run in a repository or on a linked server. */
export function scheduleSessionPath({ repoId, serverId }: ScheduleTarget, sessionId: string): string {
  return repoId === null ? getServerSessionPath(serverId, sessionId) : getSessionPath(repoId, sessionId)
}
