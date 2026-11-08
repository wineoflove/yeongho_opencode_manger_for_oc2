import { describe, it, expect } from 'vitest'
import { format, formatDistanceToNow } from 'date-fns'
import { setLocale } from './locale'
import {
  formatCompactDuration,
  formatDate,
  formatDatePattern,
  formatDateTime,
  formatMonthDayTime,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  intlLocale,
} from './format'

const sample = new Date(2026, 9, 14, 19, 50, 7)

describe('intlLocale', () => {
  it('maps the app locale', () => {
    expect(intlLocale()).toBe('en-US')
    setLocale('ko')
    expect(intlLocale()).toBe('ko-KR')
  })
})

describe('date formats', () => {
  it('formats in en', () => {
    expect(formatDateTime(sample)).toBe('10/14/2026, 19:50')
    expect(formatDate(sample)).toBe('10/14/2026')
    expect(formatTime(sample)).toBe('19:50')
    expect(formatTime(sample, { seconds: true })).toBe('19:50:07')
    expect(formatMonthDayTime(new Date(2026, 9, 11, 19, 50))).toBe('10/11, 19:50')
  })

  it('formats in ko', () => {
    setLocale('ko')

    expect(formatDateTime(sample)).toBe('2026. 10. 14. 19:50')
    expect(formatDate(sample)).toBe('2026. 10. 14.')
    expect(formatTime(sample, { seconds: true })).toBe('19:50:07')
    expect(formatMonthDayTime(new Date(2026, 9, 11, 19, 50))).toBe('10. 11. 19:50')
  })

  it('accepts timestamps and ISO strings', () => {
    setLocale('ko')

    expect(formatDateTime(sample.getTime())).toBe('2026. 10. 14. 19:50')
    expect(formatDateTime(sample.toISOString())).toBe('2026. 10. 14. 19:50')
  })
})

describe('number formats', () => {
  it('formats numbers and percents', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(1.5, { minimumFractionDigits: 2 })).toBe('1.50')
    expect(formatPercent(0.1234)).toBe('12.3%')
    expect(formatPercent(0.5, 0)).toBe('50%')
    setLocale('ko')
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatPercent(0.1234)).toBe('12.3%')
  })
})

describe('formatRelativeTime', () => {
  const twoHoursAgo = () => Date.now() - 2 * 60 * 60 * 1000

  it('matches the previous en output', () => {
    const value = twoHoursAgo()

    expect(formatRelativeTime(value)).toBe('about 2 hours ago')
    expect(formatRelativeTime(value)).toBe(`${formatDistanceToNow(value)} ago`)
  })

  it('uses korean in ko', () => {
    setLocale('ko')

    expect(formatRelativeTime(twoHoursAgo())).toBe('약 2시간 전')
  })
})

describe('formatCompactDuration', () => {
  it('formats in en', () => {
    expect(formatCompactDuration(42000)).toBe('42s')
    expect(formatCompactDuration(305000)).toBe('5m 05s')
    expect(formatCompactDuration(3720000)).toBe('1h 02m')
  })

  it('formats in ko', () => {
    setLocale('ko')

    expect(formatCompactDuration(42000)).toBe('42초')
    expect(formatCompactDuration(305000)).toBe('5분 05초')
    expect(formatCompactDuration(3720000)).toBe('1시간 02분')
  })
})

describe('formatDatePattern', () => {
  it('uses the en pattern unchanged in en', () => {
    expect(formatDatePattern(sample, 'MMM d HH:mm', 'M월 d일 HH:mm')).toBe(format(sample, 'MMM d HH:mm'))
  })

  it('uses the ko pattern in ko', () => {
    setLocale('ko')

    expect(formatDatePattern(sample, 'MMM d HH:mm', 'M월 d일 HH:mm')).toBe('10월 14일 19:50')
  })
})
