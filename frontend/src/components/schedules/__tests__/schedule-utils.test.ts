import { describe, expect, it } from 'vitest'
import { formatRunDuration, formatIntervalLabel, matchesScheduleJobSearch } from '@/components/schedules/schedule-utils'
import { getLocale, setLocale } from '@/i18n/locale'
import { formatCronHumanText } from '@/components/schedules/schedule-utils'
import type { ScheduleJob } from '@opencode-manager/shared/types'

describe('formatRunDuration', () => {
  it('uses Korean cron descriptions and preserves invalid-expression handling', () => {
    const previous = getLocale()
    try {
      setLocale('ko')
      expect(formatCronHumanText('* * * * *')).toBe('1분마다')
      expect(formatCronHumanText('invalid')).toBeNull()
      setLocale('en')
      expect(formatCronHumanText('* * * * *')).toBe('Every minute')
    } finally {
      setLocale(previous)
    }
  })
  it.each([
    [1, '1분마다', 'Every 1 minute'],
    [15, '15분마다', 'Every 15 minutes'],
    [60, '1시간마다', 'Every 1 hour'],
    [120, '2시간마다', 'Every 2 hours'],
    [1440, '1일마다', 'Every 1 day'],
    [2880, '2일마다', 'Every 2 days'],
  ] as const)('localizes an interval of %i minutes without changing its unit', (minutes, korean, english) => {
    const previous = getLocale()
    try {
      setLocale('ko')
      expect(formatIntervalLabel(minutes)).toBe(korean)
      setLocale('en')
      expect(formatIntervalLabel(minutes)).toBe(english)
    } finally {
      setLocale(previous)
    }
  })
  it('formats seconds, minutes, and hours', () => {
    expect(formatRunDuration({ startedAt: 0, finishedAt: 45_000 })).toBe('45s')
    expect(formatRunDuration({ startedAt: 0, finishedAt: 192_000 })).toBe('3m 12s')
    expect(formatRunDuration({ startedAt: 0, finishedAt: 3_840_000 })).toBe('1h 4m')
  })

  it('measures running runs against now', () => {
    expect(formatRunDuration({ startedAt: 1_000, finishedAt: null }, 31_000)).toBe('30s')
  })
})

describe('matchesScheduleJobSearch', () => {
  const job = {
    name: 'Docs drift review',
    description: 'Check README drift',
    repoName: 'vllm',
  } as ScheduleJob & { repoName: string }

  it('matches name, description, and repo case-insensitively', () => {
    expect(matchesScheduleJobSearch(job, 'DRIFT')).toBe(true)
    expect(matchesScheduleJobSearch(job, 'readme')).toBe(true)
    expect(matchesScheduleJobSearch(job, 'vllm')).toBe(true)
    expect(matchesScheduleJobSearch(job, 'triage')).toBe(false)
  })

  it('matches everything for a blank term', () => {
    expect(matchesScheduleJobSearch(job, '   ')).toBe(true)
  })
})
