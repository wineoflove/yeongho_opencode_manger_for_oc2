import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLocale, setLocale, type Locale } from '@/i18n/locale'
import { formatScheduleWorktreeLabel } from './schedule-worktree'
import { callOpenCode } from '@/api/opencodeApi'

describe('localized schedule labels and API fallback', () => {
  let previous: Locale
  beforeEach(() => {
    previous = getLocale()
  })
  afterEach(() => setLocale(previous))
  it.each([
    ['ko', '공유 워크트리', '실행 #340', '요청에 실패했습니다'],
    ['en', 'Shared worktree', 'Run #340', 'Request failed'],
  ] as const)('uses the current locale %s without changing identifiers', async (locale, shared, run, failure) => {
    setLocale(locale)
    expect(formatScheduleWorktreeLabel(null)).toBe(shared)
    expect(formatScheduleWorktreeLabel(340)).toBe(run)
    await expect(callOpenCode(async () => Promise.reject(null))).rejects.toMatchObject({
      message: failure,
      statusCode: 0,
    })
  })
})
