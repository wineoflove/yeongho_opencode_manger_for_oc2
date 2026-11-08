import type { ScheduleOverviewRecentRun } from '@opencode-manager/shared/schemas'
import { formatMonthDayTime } from '@/i18n/format'
import { t, msg } from '@/i18n/translate'
import { formatDuration } from '@/lib/scheduleOverview'

const labels = {
  running: msg('Running'),
  completed: msg('Succeeded'),
  succeeded: msg('Succeeded'),
  failed: msg('Failed'),
  blocked: msg('Blocked'),
  partial: msg('Partial'),
  skipped: msg('Skipped'),
  cancelled: msg('Cancelled'),
  unreported: msg('Unreported'),
}

export function RecentRunsStrip({ runs }: { readonly runs: readonly ScheduleOverviewRecentRun[] }) {
  return (
    <div className="flex flex-wrap gap-1" aria-label={t('Recent runs')}>
      {[...runs]
        .sort((left, right) => left.startedAt - right.startedAt)
        .slice(-20)
        .map((run) => {
          const outcome = run.status === 'running' ? 'running' : (run.outcome ?? run.status)
          const tone =
            outcome === 'running'
              ? 'bg-sky-500'
              : outcome === 'succeeded'
                ? 'bg-green-500'
                : outcome === 'failed' || outcome === 'blocked'
                  ? 'bg-red-500'
                  : outcome === 'unreported'
                    ? 'bg-orange-500'
                    : 'bg-muted-foreground'
          const label = `${formatMonthDayTime(run.startedAt)} · ${t(labels[outcome])} · ${formatDuration(run.durationMs)}`
          return (
            <span
              key={run.runId}
              data-testid="recent-run"
              role="img"
              aria-label={label}
              title={label}
              className={`h-2.5 w-2.5 rounded-sm ${tone}`}
            />
          )
        })}
    </div>
  )
}
