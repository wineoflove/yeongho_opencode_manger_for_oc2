import { getServerSessionPath } from './navigation'
import { describe, expect, it } from 'vitest'
import {
  aggregateRemaining,
  bucketTicks,
  failureCount,
  formatDuration,
  formatElapsed,
  scheduleDetailPath,
  scheduleSessionPath,
} from './scheduleOverview'

describe('schedule overview helpers', () => {
  it('formats elapsed time independently of locale', () => {
    expect(formatElapsed(185000)).toBe('03:05')
    expect(formatElapsed(3729000)).toBe('1:02:09')
    expect(formatElapsed(-1000)).toBe('00:00')
    expect(formatDuration(305000)).toBe('5m 05s')
    expect(formatDuration(null)).toBe('Not tracked')
  })
  it('aggregates only reported remaining work and preserves a shared unit', () => {
    expect(
      aggregateRemaining([
        { remaining: 0, unit: 'items' },
        { remaining: 7, unit: 'items' },
        { remaining: null, unit: null },
      ]),
    ).toEqual({ remaining: 7, count: 2, unit: 'items' })
    expect(aggregateRemaining([])).toEqual({ remaining: null, count: 0, unit: null })
    expect(
      aggregateRemaining([
        { remaining: 2, unit: 'items' },
        { remaining: 4, unit: 'files' },
      ]).unit,
    ).toBeNull()
  })
  it('includes blocked outcomes in failures', () => {
    expect(
      failureCount({ succeeded: 8, partial: 1, failed: 2, blocked: 3, skipped: 0, unreported: 0, cancelled: 0 }),
    ).toBe(5)
  })
  it('bounds and evenly spaces ticks including the endpoints', () => {
    expect(bucketTicks(0)).toEqual([])
    expect(bucketTicks(1)).toEqual([0])
    expect(bucketTicks(30)).toEqual([0, 4, 8, 12, 17, 21, 25, 29])
  })
  it('builds job detail and one-shot run detail links with return navigation', () => {
    const local = { repoId: 3, serverId: 'local', directory: null }
    expect(scheduleDetailPath({ ...local, jobId: 7, returnTo: '/schedules' })).toBe(
      '/repos/3/schedules?jobId=7&scheduleTab=detail&returnTo=%2Fschedules',
    )
    expect(scheduleDetailPath({ ...local, jobId: 7, runId: 42, returnTo: '/schedules?view=all' })).toBe(
      '/repos/3/schedules?jobId=7&scheduleTab=runs&runId=42&returnTo=%2Fschedules%3Fview%3Dall',
    )
    expect(scheduleSessionPath(local, 'ses_1')).toBe('/repos/3/sessions/ses_1')
  })

  it('routes linked-server jobs to their server project and sessions', () => {
    const remote = { repoId: null, serverId: 'srv 1', directory: '/remote/repo' }
    expect(scheduleDetailPath({ ...remote, jobId: 7, runId: 42, returnTo: '/schedules' })).toBe(
      '/servers/srv%201/projects?directory=%2Fremote%2Frepo',
    )
    expect(scheduleDetailPath({ ...remote, directory: null, jobId: 7, returnTo: '/schedules' })).toBe('/schedules')
    expect(scheduleSessionPath(remote, 'ses_1')).toBe(getServerSessionPath('srv 1', 'ses_1'))
  })
})
