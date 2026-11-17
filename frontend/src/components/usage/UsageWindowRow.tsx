import type { UsageWindow } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import { Progress } from '@/components/ui/progress'
import { useCountdown } from '@/hooks/useAccountUsage'
import { formatRemainingDuration, formatResetAbsolute, windowUsedPercent } from '@/lib/usageFormat'
import { cn } from '@/lib/utils'

const HIGH_USAGE_PERCENT = 90
const ELEVATED_USAGE_PERCENT = 70

function barToneClass(usedPercent?: number): string {
  if (usedPercent === undefined) return ''
  if (usedPercent >= HIGH_USAGE_PERCENT) return '[&>div]:bg-destructive'
  if (usedPercent >= ELEVATED_USAGE_PERCENT) return '[&>div]:bg-amber-500'
  return ''
}

function usageSummary(window: UsageWindow, usedPercent?: number): string {
  if (window.remaining !== undefined && window.limit !== undefined) {
    return `${window.remaining}/${window.limit}`
  }
  if (usedPercent !== undefined) return t('{percent}% left', { percent: 100 - usedPercent })
  return '—'
}

function resetSummary(resetAt: number | undefined, isPast: boolean, remainingMs: number): string {
  if (resetAt === undefined) return t('Reset time unknown')
  if (isPast) return t('Window reset · awaiting next request')
  return t('Resets in {remaining} · {date}', {
    remaining: formatRemainingDuration(remainingMs),
    date: formatResetAbsolute(resetAt),
  })
}

export function UsageWindowRow({ window, historical = false }: { window: UsageWindow; historical?: boolean }) {
  const usedPercent = windowUsedPercent(window)
  const { remainingMs, isPast } = useCountdown(window.resetAt)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{t(window.label)}</span>
        <span className="font-medium tabular-nums">{usageSummary(window, usedPercent)}</span>
      </div>
      <Progress value={usedPercent ?? 0} className={cn('h-1.5', barToneClass(usedPercent))} />
      <p className="text-xs text-muted-foreground">
        {historical
          ? window.resetAt === undefined
            ? t('Last reported reset unknown')
            : t('Last reported reset: {date}', { date: formatResetAbsolute(window.resetAt) })
          : resetSummary(window.resetAt, isPast, remainingMs)}
      </p>
    </div>
  )
}
