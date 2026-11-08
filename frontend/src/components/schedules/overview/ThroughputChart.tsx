import { useState } from 'react'
import type { ScheduleOverviewBucket } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import { formatMonthDayTime } from '@/i18n/format'
import { bucketTicks, failureCount, formatDuration } from '@/lib/scheduleOverview'

export function ThroughputChart({
  series,
  range,
  hourly,
}: {
  readonly series: readonly ScheduleOverviewBucket[]
  readonly range: string
  readonly hourly: boolean
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const peakRuns = Math.max(
    1,
    ...series.map((bucket) => Object.values(bucket.outcomes).reduce((sum, count) => sum + count, 0)),
  )
  const maxRuns = peakRuns + (peakRuns % 2)
  const maxDuration = Math.max(1, ...series.map((bucket) => bucket.avgDurationMs ?? 0))
  const total = (field: 'succeeded' | 'unreported') => series.reduce((sum, bucket) => sum + bucket.outcomes[field], 0)
  const failed = series.reduce((sum, bucket) => sum + failureCount(bucket.outcomes), 0)
  const step = 520 / Math.max(1, series.length)
  const bucket = selected === null ? undefined : series[selected]
  const hasRuns = series.some((entry) => entry.runs > 0)
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 @4xl:col-span-2">
      <h2 className="text-sm font-semibold">{t('Throughput')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('Run outcomes per {unit} · {range}', { unit: hourly ? t('hour') : t('day'), range })}
      </p>
      <div className="mt-3 flex flex-wrap gap-4 text-xs tabular-nums">
        <span className="text-green-600">
          {t('Succeeded')} {total('succeeded')}
        </span>
        <span className="text-red-600">
          {t('Failed')} {failed}
        </span>
        <span className="text-orange-600">
          {t('Unreported')} {total('unreported')}
        </span>
        <span className="text-muted-foreground">{t('Other outcomes')}</span>
        <span className="text-sky-600">{t('Avg duration')}</span>
      </div>
      {!hasRuns && <p className="mt-4 text-sm text-muted-foreground">{t('No runs in this range.')}</p>}
      <svg viewBox="0 0 640 240" className="mt-4 w-full overflow-visible" aria-label={t('Throughput')}>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction} className="text-muted-foreground">
            <line
              x1="45"
              x2="565"
              y1={200 - fraction * 170}
              y2={200 - fraction * 170}
              stroke="currentColor"
              opacity="0.15"
            />
            <text x="38" y={204 - fraction * 170} textAnchor="end" fill="currentColor" fontSize="10">
              {Math.round(maxRuns * fraction)}
            </text>
            <text x="575" y={204 - fraction * 170} fill="currentColor" fontSize="10">
              {formatDuration(maxDuration * fraction)}
            </text>
          </g>
        ))}
        {series.map((entry, index) => {
          const counts = [
            entry.outcomes.succeeded,
            failureCount(entry.outcomes),
            entry.outcomes.unreported,
            entry.outcomes.partial + entry.outcomes.skipped + entry.outcomes.cancelled,
          ]
          const colors = ['fill-green-500', 'fill-red-500', 'fill-orange-500', 'fill-muted-foreground']
          let base = 200
          const label = `${formatMonthDayTime(entry.start)} · ${t('Succeeded')} ${counts[0]} · ${t('Failed')} ${counts[1]} · ${t('Unreported')} ${counts[2]} · ${t('Avg duration')} ${formatDuration(entry.avgDurationMs)}`
          return (
            <g
              key={entry.start}
              data-testid="throughput-bucket"
              role="button"
              tabIndex={0}
              aria-label={label}
              onPointerEnter={() => setSelected(index)}
              onFocus={() => setSelected(index)}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelected(index)
                }
              }}
            >
              <rect x={45 + index * step} y="25" width={step} height="175" fill="transparent" />
              {counts.map((count, position) => {
                const height = (count / maxRuns) * 170
                base -= height
                return (
                  <rect
                    key={position}
                    x={47 + index * step}
                    y={base}
                    width={Math.max(1, step - 4)}
                    height={height}
                    className={colors[position]}
                    opacity={selected === null || selected === index ? 0.9 : 0.5}
                  />
                )
              })}
              <title>{label}</title>
            </g>
          )
        })}
        {series.map((entry, index) => {
          if (entry.avgDurationMs === null) return null
          const previous = series[index - 1]
          const x = 45 + (index + 0.5) * step
          const y = 200 - (entry.avgDurationMs / maxDuration) * 170
          return (
            <g key={entry.start} className="text-sky-500" pointerEvents="none">
              {previous?.avgDurationMs != null && (
                <line
                  x1={x - step}
                  y1={200 - (previous.avgDurationMs / maxDuration) * 170}
                  x2={x}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="2"
                />
              )}
              <circle cx={x} cy={y} r="3" fill="currentColor" />
            </g>
          )
        })}
        {bucketTicks(series.length).map((index) => (
          <text
            key={index}
            x={45 + (index + 0.5) * step}
            y="225"
            textAnchor="middle"
            fontSize="10"
            className="fill-muted-foreground"
          >
            {series[index].label}
          </text>
        ))}
      </svg>
      {bucket && (
        <div className="mt-2 rounded-md bg-muted p-3 text-xs tabular-nums" role="status">
          <p className="font-medium">{formatMonthDayTime(bucket.start)}</p>
          <p>
            {t('Succeeded')} {bucket.outcomes.succeeded} · {t('Failed')} {bucket.outcomes.failed} · {t('Blocked')}{' '}
            {bucket.outcomes.blocked} · {t('Partial')} {bucket.outcomes.partial} · {t('Skipped')}{' '}
            {bucket.outcomes.skipped} · {t('Cancelled')} {bucket.outcomes.cancelled} · {t('Unreported')}{' '}
            {bucket.outcomes.unreported}
          </p>
          <p>
            {t('Avg duration')} {formatDuration(bucket.avgDurationMs)}
          </p>
        </div>
      )}
    </section>
  )
}
