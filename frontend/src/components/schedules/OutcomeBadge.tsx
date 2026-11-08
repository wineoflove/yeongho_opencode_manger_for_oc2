import type { ScheduleRunOutcome } from '@opencode-manager/shared/schemas'
import { cn } from '@/lib/utils'
import { msg, t } from '@/i18n/translate'

const OUTCOMES: Record<ScheduleRunOutcome | 'running', { label: string; tone: string }> = {
  succeeded: { label: msg('Succeeded'), tone: 'border-success/40 text-success' },
  partial: { label: msg('Partial'), tone: 'border-warning/40 text-warning' },
  failed: { label: msg('Failed'), tone: 'border-destructive/40 text-destructive' },
  blocked: { label: msg('Blocked'), tone: 'border-destructive/40 text-destructive' },
  skipped: { label: msg('Skipped'), tone: 'border-border text-muted-foreground' },
  unreported: { label: msg('Unreported'), tone: 'border-warning/40 text-warning' },
  cancelled: { label: msg('Cancelled'), tone: 'border-border text-muted-foreground' },
  running: { label: msg('Running'), tone: 'border-primary/40 text-primary' },
}

/** Shows the outcome a scheduled run reported, how it was classified when it did not report one, or that it is still running. */
export function OutcomeBadge({ outcome }: { readonly outcome: ScheduleRunOutcome | 'running' }) {
  const entry = OUTCOMES[outcome]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        entry.tone,
      )}
    >
      {t(entry.label)}
    </span>
  )
}
