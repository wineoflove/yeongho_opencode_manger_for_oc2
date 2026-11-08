import type { ScheduleOverviewResponse } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import { formatPercent } from '@/i18n/format'
import { aggregateRemaining, failureCount, formatDuration } from '@/lib/scheduleOverview'
import { formatCost, formatTokens } from '@/lib/tokenStats'
import { Sparkline } from './Sparkline'

export function OverviewMetrics({ data, range }: { readonly data: ScheduleOverviewResponse; readonly range: string }) {
  const { current, previous } = data.totals
  const remaining = aggregateRemaining(data.jobs)
  const metrics = [
    {
      label: t('Running'),
      value: String(data.running.length),
      detail: t('{n} enabled jobs', { n: data.enabledJobs }),
      series: data.series.map((bucket) => bucket.maxConcurrent),
    },
    {
      label: t('Remaining'),
      value:
        remaining.remaining === null ? null : `${remaining.remaining}${remaining.unit ? ` ${remaining.unit}` : ''}`,
      detail: t('from {n} reporting jobs', { n: remaining.count }),
      series: [],
    },
    {
      label: t('Success rate ({range})', { range }),
      value: current.successRate === null ? null : formatPercent(current.successRate),
      detail: t('{succeeded} of {terminal} runs · {processed} items', {
        succeeded: current.outcomes.succeeded,
        terminal: current.terminal,
        processed: current.processed,
      }),
      series: data.series.map((bucket) => {
        const terminal = Object.values(bucket.outcomes).reduce((sum, count) => sum + count, 0)
        return terminal ? bucket.outcomes.succeeded / terminal : null
      }),
    },
    {
      label: t('Failures ({range})', { range }),
      value: String(failureCount(current.outcomes)),
      detail: t('incl. {blocked} blocked · previous {previous}', {
        blocked: current.outcomes.blocked,
        previous: failureCount(previous.outcomes),
      }),
      series: data.series.map((bucket) => failureCount(bucket.outcomes)),
      danger: failureCount(current.outcomes) > 0,
    },
    {
      label: t('Avg duration'),
      value: current.avgDurationMs === null ? null : formatDuration(current.avgDurationMs),
      detail: t('p90 {duration}', { duration: formatDuration(current.p90DurationMs) }),
      series: data.series.map((bucket) => bucket.avgDurationMs),
    },
    {
      label: t('Est. cost ({range})', { range }),
      value: current.estimatedCost === null ? null : formatCost(current.estimatedCost),
      detail: t('{tokens} tokens', { tokens: formatTokens(current.tokens) }),
      series: data.series.map((bucket) => bucket.estimatedCost),
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-6">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          data-testid="overview-kpi"
          className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4"
        >
          <p className="text-xs text-muted-foreground">{metric.label}</p>
          <p
            className={`mt-2 break-words text-xl font-semibold tabular-nums ${metric.danger ? 'text-red-600' : metric.value === null ? 'text-muted-foreground' : ''}`}
          >
            {metric.value ?? t('Not tracked')}
          </p>
          <p className="mb-3 mt-1 flex-1 text-xs text-muted-foreground">{metric.detail}</p>
          {metric.series.length > 0 && <Sparkline values={metric.series} />}
        </div>
      ))}
    </div>
  )
}
