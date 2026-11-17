import { afterEach, describe, expect, it } from 'vitest'
import { format } from 'date-fns'
import { setLocale } from '../i18n/locale'
import {
  effectiveUsedPercent,
  formatRemainingDuration,
  formatResetAbsolute,
  isWindowElapsed,
  summaryWindows,
  windowUsedPercent,
  displayUsageWindows,
} from './usageFormat'

afterEach(() => setLocale('en'))

describe('formatRemainingDuration', () => {
  it.each([
    [24 * 3600000, '1d 00h 00m'],
    [(2 * 24 + 3) * 3600000 + 15 * 60000, '2d 03h 15m'],
    [155 * 3600000 + 46 * 60000, '6d 11h 46m'],
    [24 * 3600000 - 1000, '23h 59m'],
  ])('formats %i milliseconds across the day boundary as %s', (duration, expected) => {
    expect(formatRemainingDuration(duration)).toBe(expected)
  })

  it.each([
    [24 * 3600000, '1일 00시간 00분'],
    [(4 * 24 + 9) * 3600000 + 44 * 60000 + 59000, '4일 09시간 44분'],
    [(12 * 24 + 23) * 3600000 + 5 * 60000, '12일 23시간 05분'],
    [4 * 3600000 + 54 * 60000, '4시간 54분'],
  ])('formats %i milliseconds in Korean as %s', (duration, expected) => {
    setLocale('ko')
    expect(formatRemainingDuration(duration)).toBe(expected)
  })

  it('formats hours with zero-padded minutes', () => {
    expect(formatRemainingDuration(2 * 3600000 + 5 * 60000)).toBe('2h 05m')
  })

  it('formats minutes with zero-padded seconds', () => {
    expect(formatRemainingDuration(45 * 60000 + 10000)).toBe('45m 10s')
  })

  it('zero-pads single digit seconds under a minute boundary', () => {
    expect(formatRemainingDuration(60000 + 5000)).toBe('1m 05s')
  })

  it('formats seconds only under one minute', () => {
    expect(formatRemainingDuration(45000)).toBe('45s')
  })

  it('formats zero as seconds', () => {
    expect(formatRemainingDuration(0)).toBe('0s')
  })

  it('returns a dash for undefined', () => {
    expect(formatRemainingDuration(undefined)).toBe('—')
  })

  it('returns a dash for negative durations', () => {
    expect(formatRemainingDuration(-1000)).toBe('—')
  })
})

describe('formatResetAbsolute', () => {
  it('formats a timestamp as MMM d HH:mm', () => {
    const target = new Date(2026, 8, 9, 14, 5).getTime()
    expect(formatResetAbsolute(target)).toBe('Sep 9 14:05')
  })

  it('matches the date-fns pattern used by the rest of the app', () => {
    const target = new Date(2026, 0, 31, 7, 9).getTime()
    expect(formatResetAbsolute(target)).toBe(format(new Date(target), 'MMM d HH:mm'))
  })
})

describe('windowUsedPercent', () => {
  it('derives the percentage from limit and remaining', () => {
    expect(windowUsedPercent({ limit: 100, remaining: 25 })).toBe(75)
  })

  it('prefers an explicit usedPercent', () => {
    expect(windowUsedPercent({ usedPercent: 35 })).toBe(35)
  })

  it('returns undefined without usable numbers', () => {
    expect(windowUsedPercent({})).toBeUndefined()
  })

  it('returns undefined when only a limit is present', () => {
    expect(windowUsedPercent({ limit: 100 })).toBeUndefined()
  })

  it('returns undefined for a zero limit', () => {
    expect(windowUsedPercent({ limit: 0, remaining: 0 })).toBeUndefined()
  })

  it('returns undefined for a negative limit', () => {
    expect(windowUsedPercent({ limit: -100, remaining: 25 })).toBeUndefined()
  })

  it('clamps usage to zero when remaining exceeds the limit', () => {
    expect(windowUsedPercent({ limit: 100, remaining: 125 })).toBe(0)
  })

  it('returns undefined for negative remaining', () => {
    expect(windowUsedPercent({ limit: 100, remaining: -1 })).toBeUndefined()
  })

  it('rounds the derived percentage', () => {
    expect(windowUsedPercent({ limit: 3, remaining: 1 })).toBe(67)
  })

  it('keeps an explicit usedPercent of zero', () => {
    expect(windowUsedPercent({ usedPercent: 0, limit: 100, remaining: 25 })).toBe(0)
  })
})

describe('displayUsageWindows', () => {
  const windows = [
    { key: 'five_hour' as const, label: '5 hours', usedPercent: 11, resetAt: 1000 + 6 * 86_400_000, updatedAt: 1000 },
    { key: 'weekly' as const, label: 'Weekly', usedPercent: 0 },
  ]

  it('presents the only OpenAI Pro limit as a single 7 days window', () => {
    expect(displayUsageWindows({ provider: 'openai', planType: 'pro', windows })).toEqual([
      { ...windows[0], key: 'weekly', label: '7 days' },
    ])
  })

  it('keeps both windows for plans with a real 5 hour limit and for Anthropic', () => {
    const plus = [{ ...windows[0], resetAt: 1000 + 3_600_000 }, windows[1]]
    expect(displayUsageWindows({ provider: 'openai', planType: 'plus', windows: plus })).toEqual(plus)
    expect(displayUsageWindows({ provider: 'anthropic', planType: 'pro', windows })).toEqual(windows)
  })
})

describe('summaryWindows', () => {
  const claude = [
    { key: 'five_hour' as const, label: '5 hours', usedPercent: 0, resetAt: 5000 },
    { key: 'seven_day' as const, label: '7 days', usedPercent: 33, resetAt: 9000 },
    { key: 'seven_day_fable' as const, label: 'Fable only · 7 days', usedPercent: 1, resetAt: 9000 },
  ]

  it('uses the Claude 5 hour window as primary even when the 7 day window is higher', () => {
    expect(summaryWindows({ provider: 'anthropic', windows: claude })).toEqual({
      primary: claude[0],
      secondary: claude[1],
    })
  })

  it('uses the only displayed OpenAI Pro window as primary', () => {
    const pro = [
      { key: 'five_hour' as const, label: '5 hours', usedPercent: 11, resetAt: 1000 + 6 * 86_400_000, updatedAt: 1000 },
    ]
    expect(summaryWindows({ provider: 'openai', planType: 'pro', windows: pro })).toEqual({
      primary: { ...pro[0], key: 'weekly', label: '7 days' },
      secondary: undefined,
    })
  })

  it('pairs an OpenAI 5 hour primary with its weekly window', () => {
    const plus = [
      { key: 'five_hour' as const, label: '5 hours', usedPercent: 10, resetAt: 1000 + 3_600_000, updatedAt: 1000 },
      { key: 'weekly' as const, label: 'Weekly', usedPercent: 40 },
    ]
    expect(summaryWindows({ provider: 'openai', planType: 'plus', windows: plus })).toEqual({
      primary: plus[0],
      secondary: plus[1],
    })
  })

  it('treats elapsed windows as reset instead of reporting stale usage', () => {
    expect(isWindowElapsed({ resetAt: 5000 }, 5000)).toBe(true)
    expect(effectiveUsedPercent(claude[1], 10_000)).toBeUndefined()
    expect(effectiveUsedPercent(claude[1], 8000)).toBe(33)
    expect(isWindowElapsed({}, 10_000)).toBe(false)
  })
})
