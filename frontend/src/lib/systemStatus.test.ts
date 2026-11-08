import { describe, expect, it } from 'vitest'
import { formatBytes, formatLiveLabel, getLiveState, levelLabel, segmentsFilled } from './systemStatus'
import { setLocale } from '@/i18n/locale'

describe('system status formatting', () => {
  const clock = { dataUpdatedAt: 100_000, errorUpdatedAt: 0, now: 105_000, hidden: false }

  it('prioritizes paused, offline, stale and live states', () => {
    expect(getLiveState(clock)).toBe('live')
    expect(getLiveState({ ...clock, now: 175_000 })).toBe('stale')
    expect(getLiveState({ ...clock, now: 174_999 })).toBe('live')
    expect(getLiveState({ ...clock, errorUpdatedAt: 101_000 })).toBe('offline')
    expect(getLiveState({ ...clock, hidden: true, errorUpdatedAt: 101_000 })).toBe('paused')
  })

  it('formats live age boundaries', () => {
    expect(formatLiveLabel(clock)).toBe('Live · updated just now')
    expect(formatLiveLabel({ ...clock, now: 110_000 })).toBe('Live · updated 10s ago')
    expect(formatLiveLabel({ ...clock, now: 175_000 })).toBe('Stale · updated 1m ago')
    expect(formatLiveLabel({ ...clock, hidden: true })).toBe('Paused')
    expect(formatLiveLabel({ ...clock, errorUpdatedAt: 101_000 })).toMatch(/^Offline · last update /)
  })

  it('formats binary byte units and missing values', () => {
    expect(formatBytes(736.6 * 1024 ** 2)).toBe('736.6 MB')
    expect(formatBytes(10.1 * 1024 ** 3)).toBe('10.1 GB')
    expect(formatBytes(null)).toBe('n/a')
  })

  it('clamps and rounds meter segments', () => {
    expect([-1, 0, 0.37, 0.7, 2].map((value) => segmentsFilled(value, 12))).toEqual([0, 0, 4, 8, 12])
  })

  it('translates state labels at call time', () => {
    setLocale('ko')
    expect(levelLabel('normal')).toBe('정상')
    expect(formatLiveLabel(clock)).toBe('LIVE · 방금 갱신')
  })
})
