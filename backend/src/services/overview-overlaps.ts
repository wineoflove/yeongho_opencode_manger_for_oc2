import type { ScheduleOverviewJob } from '@opencode-manager/shared/schemas'

export function buildOverlaps(
  jobs: readonly ScheduleOverviewJob[],
  fireTimes: ReadonlyMap<number, readonly number[]>,
): Map<number, ScheduleOverviewJob['overlaps']> {
  const intervals = jobs
    .filter((job) => job.enabled)
    .flatMap((job) =>
      (fireTimes.get(job.jobId) ?? []).map((at) => ({
        jobId: job.jobId,
        name: job.name,
        at,
        end: at + Math.max(job.p90DurationMs ?? 900000, 60000),
      })),
    )
    .sort((left, right) => left.at - right.at || left.jobId - right.jobId)
  const active = new Map<number, { jobId: number; name: string; at: number; end: number }[]>()
  const found = new Map<number, Map<number, { jobId: number; name: string; at: number }>>()
  for (const interval of intervals) {
    for (const [jobId, entries] of active) {
      let expired = 0
      while (expired < entries.length && (entries[expired]?.end ?? Infinity) <= interval.at) expired++
      if (expired) entries.splice(0, expired)
      if (entries.length === 0) {
        active.delete(jobId)
        continue
      }
      if (jobId === interval.jobId) continue
      const earliest = entries[0]
      if (!earliest) continue
      const own = found.get(interval.jobId) ?? new Map()
      const other = found.get(jobId) ?? new Map()
      if (!own.has(jobId)) own.set(jobId, { jobId, name: earliest.name, at: interval.at })
      if (!other.has(interval.jobId))
        other.set(interval.jobId, { jobId: interval.jobId, name: interval.name, at: earliest.at })
      found.set(interval.jobId, own)
      found.set(jobId, other)
    }
    const entries = active.get(interval.jobId) ?? []
    entries.push(interval)
    active.set(interval.jobId, entries)
  }
  return new Map(
    jobs.map((job) => [
      job.jobId,
      [...(found.get(job.jobId)?.values() ?? [])]
        .sort((left, right) => left.at - right.at || left.jobId - right.jobId)
        .slice(0, 10),
    ]),
  )
}
