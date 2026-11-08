export type OverviewWindowDays = 1 | 7 | 30
export const OVERVIEW_DAY_MS = 86_400_000

function localParts(time: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(time)
  const value = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === kind)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function localUtc(time: number, tz: string): number {
  const parts = localParts(time, tz)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function startOfLocal(time: number, tz: string, hourly: boolean): number {
  const parts = localParts(time, tz)
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, hourly ? parts.hour : 0)
  const first = target - (localUtc(target, tz) - target)
  const corrected = target - (localUtc(first, tz) - first)
  if (hourly) {
    const currentOffset = localUtc(time, tz) - Math.floor(time / 1000) * 1000
    const candidate = target - currentOffset
    if (localUtc(candidate, tz) === target) return candidate
  }
  return corrected
}

export function startOfLocalHour(time: number, tz: string): number {
  return startOfLocal(time, tz, true)
}

export function startOfLocalDay(time: number, tz: string): number {
  return startOfLocal(time, tz, false)
}

export function buildOverviewWindow(now: number, windowDays: OverviewWindowDays, tz: string) {
  const count = windowDays === 1 ? 24 : windowDays
  const starts = [windowDays === 1 ? startOfLocalHour(now, tz) : startOfLocalDay(now, tz)]
  let cursor = starts[0] ?? now
  for (let index = 1; index < count * 2; index++) {
    cursor = windowDays === 1 ? startOfLocalHour(cursor - 1, tz) : startOfLocalDay(cursor - 1, tz)
    starts.unshift(cursor)
  }
  const currentStarts = starts.slice(count)
  const from = currentStarts[0] ?? now
  const buckets = currentStarts.map((start, index) => {
    const parts = localParts(start, tz)
    const pad = (value: number) => String(value).padStart(2, '0')
    return {
      start,
      to: currentStarts[index + 1] ?? now,
      label: windowDays === 1 ? `${pad(parts.hour)}:00` : `${pad(parts.month)}.${pad(parts.day)}`,
    }
  })
  return { window: { from, to: now }, previousWindow: { from: starts[0] ?? from, to: from }, buckets }
}
