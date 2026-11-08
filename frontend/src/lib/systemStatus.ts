import type { SystemLevel } from '@opencode-manager/shared/schemas'
import { formatNumber, formatTime } from '@/i18n/format'
import { msg, t } from '@/i18n/translate'

export const browserCategories = [
  { key: 'chrome', label: 'Chrome', color: 'bg-blue-500' },
  { key: 'playwright', label: 'Playwright', color: 'bg-cyan-400' },
  { key: 'headless', label: msg('Headless'), color: 'bg-purple-500' },
  { key: 'agentBrowser', label: msg('Agent browser'), color: 'bg-pink-500' },
] as const

export interface LiveClock {
  readonly dataUpdatedAt: number
  readonly errorUpdatedAt: number
  readonly now: number
  readonly hidden: boolean
}

export function getLiveState(clock: LiveClock) {
  if (clock.hidden) return 'paused'
  if (clock.errorUpdatedAt > clock.dataUpdatedAt) return 'offline'
  if (clock.now - clock.dataUpdatedAt >= 75_000) return 'stale'
  return 'live'
}

export function formatLiveLabel(clock: LiveClock): string {
  const age = Math.max(0, clock.now - clock.dataUpdatedAt)
  switch (getLiveState(clock)) {
    case 'paused':
      return t('Paused')
    case 'offline':
      return t('Offline · last update {time}', {
        time: clock.dataUpdatedAt ? formatTime(clock.dataUpdatedAt, { seconds: true }) : t('n/a'),
      })
    case 'stale':
      return t('Stale · updated {n}m ago', { n: formatNumber(Math.floor(age / 60_000)) })
    case 'live':
      return age < 10_000
        ? t('Live · updated just now')
        : t('Live · updated {n}s ago', { n: formatNumber(Math.floor(age / 1000)) })
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return t('n/a')
  const unit = bytes >= 1024 ** 3 ? 'GB' : bytes >= 1024 ** 2 ? 'MB' : bytes >= 1024 ? 'KB' : 'B'
  const divisor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit]
  return `${formatNumber(bytes / divisor, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`
}

export function segmentsFilled(fraction: number, count = 12): number {
  return Math.round(count * Math.min(1, Math.max(0, fraction)))
}

export function levelLabel(level: SystemLevel): string {
  switch (level) {
    case 'normal':
      return t('Normal')
    case 'warning':
      return t('Warning')
    case 'critical':
      return t('Critical')
    case 'unknown':
      return t('Unknown')
  }
}

export function systemNumber(value: number | null, digits = 0): string {
  return value === null
    ? t('n/a')
    : formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
