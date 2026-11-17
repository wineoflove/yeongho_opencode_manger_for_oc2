import { formatCompactDuration, formatDatePattern } from '@/i18n/format'
import { getLocale } from '@/i18n/locale'
import { msg } from '@/i18n/translate'
import type { AccountUsage, UsageWindow } from '@opencode-manager/shared/schemas'

type UsageWindowValues = Pick<UsageWindow, 'usedPercent' | 'remaining' | 'limit'>

export interface SummaryWindows {
  readonly primary?: UsageWindow
  readonly secondary?: UsageWindow
}

const NO_VALUE = '—'
const WEEKLY_PRIMARY_PLANS: ReadonlySet<string> = new Set(['pro', 'prolite'])
const SUMMARY_WINDOW_KEYS: ReadonlySet<UsageWindow['key']> = new Set(['five_hour', 'seven_day', 'weekly'])
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatRemainingDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return NO_VALUE
  if (ms < DAY_MS) return formatCompactDuration(ms)

  const totalMinutes = Math.floor(ms / MINUTE_MS)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  return getLocale() === 'ko'
    ? `${days}일 ${padTwo(hours)}시간 ${padTwo(minutes)}분`
    : `${days}d ${padTwo(hours)}h ${padTwo(minutes)}m`
}

export function formatResetAbsolute(ms: number): string {
  return formatDatePattern(ms, 'MMM d HH:mm', 'M월 d일 HH:mm')
}

export function windowUsedPercent(window: UsageWindowValues): number | undefined {
  if (window.usedPercent !== undefined) {
    return Math.min(100, Math.max(0, window.usedPercent))
  }
  const { limit, remaining } = window
  if (limit === undefined || limit <= 0 || remaining === undefined || remaining < 0) {
    return undefined
  }
  return Math.min(100, Math.max(0, Math.round((1 - remaining / limit) * 100)))
}

export function displayUsageWindows(account: Pick<AccountUsage, 'provider' | 'planType' | 'windows'>): UsageWindow[] {
  const primaryWindow = account.windows.find((window) => window.key === 'five_hour')
  const hasWeeklyPrimary =
    account.provider === 'openai' &&
    primaryWindow !== undefined &&
    (WEEKLY_PRIMARY_PLANS.has(account.planType?.trim().toLowerCase() ?? '') ||
      (primaryWindow.resetAt !== undefined &&
        primaryWindow.updatedAt !== undefined &&
        primaryWindow.resetAt - primaryWindow.updatedAt > FIVE_HOURS_MS))
  return hasWeeklyPrimary && primaryWindow
    ? [{ ...primaryWindow, key: 'weekly', label: msg('7 days') }]
    : account.windows
}

export function summaryWindows(account: Pick<AccountUsage, 'provider' | 'planType' | 'windows'>): SummaryWindows {
  const windows = displayUsageWindows(account).filter((window) => SUMMARY_WINDOW_KEYS.has(window.key))
  const primary = windows.find((window) => window.key === 'five_hour') ?? windows[0]
  return { primary, secondary: windows.find((window) => window !== primary) }
}

export function isWindowElapsed(window: Pick<UsageWindow, 'resetAt'>, now: number): boolean {
  return window.resetAt !== undefined && window.resetAt <= now
}

export function effectiveUsedPercent(window: UsageWindow, now: number): number | undefined {
  return isWindowElapsed(window, now) ? undefined : windowUsedPercent(window)
}
