import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useScheduleOverview } from '@/hooks/useScheduleOverview'
import { Button } from '@/components/ui/button'
import { formatTime } from '@/i18n/format'
import { t, msg } from '@/i18n/translate'
import { describeError } from '@/i18n/errors'
import { OverviewMetrics } from './overview/OverviewMetrics'
import { ThroughputChart } from './overview/ThroughputChart'
import { RunningNowPanel } from './overview/RunningNowPanel'
import { OverviewJobs } from './overview/OverviewJobs'

const ranges = [
  { days: 1, label: msg('24h') },
  { days: 7, label: msg('7d') },
  { days: 30, label: msg('30d') },
] as const

/** Global automation dashboard: run totals, throughput, running and upcoming work, and per-job health. */
export function OverviewTab() {
  const [windowDays, setWindowDays] = useState<1 | 7 | 30>(7)
  const { data, isLoading, isFetching, error, refetch } = useScheduleOverview(windowDays)
  const location = useLocation()
  const returnTo = `${location.pathname}${location.search}`
  const range = t(ranges.find((entry) => entry.days === windowDays)?.label ?? msg('7d'))
  const describedError = error ? describeError(error.message) : null
  return (
    <div className="@container min-w-0 space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t('Automation overview')}</h1>
          {data && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('Active jobs {enabled}/{total} · Running {running} · Updated {time}', {
                enabled: data.enabledJobs,
                total: data.totalJobs,
                running: data.running.length,
                time: formatTime(data.generatedAt, { seconds: true }),
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('Time range')}
            className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-card p-0.5"
          >
            {ranges.map((entry) => (
              <button
                key={entry.days}
                type="button"
                role="radio"
                aria-checked={windowDays === entry.days}
                onClick={() => setWindowDays(entry.days)}
                className={`min-h-11 rounded-md px-2.5 py-1 text-xs font-medium ${windowDays === entry.days ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            {t('Refresh')}
          </Button>
        </div>
      </header>
      {describedError && (
        <div role="alert" className="rounded-lg border border-border p-4">
          <p>{describedError.title}</p>
          <p className="break-words text-xs text-muted-foreground">{describedError.detail}</p>
          <Button variant="outline" onClick={() => void refetch()}>
            {t('Retry')}
          </Button>
        </div>
      )}
      {isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading…')}
        </p>
      )}
      {data && (
        <>
          <OverviewMetrics data={data} range={range} />
          <div className="grid gap-4 @4xl:grid-cols-3">
            <ThroughputChart series={data.series} range={range} hourly={windowDays === 1} />
            <RunningNowPanel running={data.running} upcoming={data.upcoming} returnTo={returnTo} />
          </div>
          <OverviewJobs
            jobs={data.jobs}
            totalJobs={data.totalJobs}
            enabledJobs={data.enabledJobs}
            returnTo={returnTo}
          />
        </>
      )}
    </div>
  )
}
