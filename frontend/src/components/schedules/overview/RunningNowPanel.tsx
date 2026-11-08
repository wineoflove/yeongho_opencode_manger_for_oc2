import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { SquareArrowOutUpRight } from 'lucide-react'
import { isSameDay } from 'date-fns'
import type { ScheduleOverviewRunning, ScheduleOverviewUpcoming } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import { formatTime, formatMonthDayTime } from '@/i18n/format'
import { formatDuration, formatElapsed, scheduleDetailPath, scheduleSessionPath } from '@/lib/scheduleOverview'

export function RunningNowPanel({
  running,
  upcoming,
  returnTo,
}: {
  readonly running: readonly ScheduleOverviewRunning[]
  readonly upcoming: readonly ScheduleOverviewUpcoming[]
  readonly returnTo: string
}) {
  const navigate = useNavigate()
  const [now, setNow] = useState(Date.now)
  const hasRunning = running.length > 0
  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasRunning])
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('Running now')}</h2>
        <span className="text-xs text-muted-foreground">{t('{n} running', { n: running.length })}</span>
      </div>
      <div className="mt-3 space-y-3">
        {!hasRunning && <p className="text-sm text-muted-foreground">{t('Nothing running.')}</p>}
        {running.map((run) => {
          const elapsed = Math.max(0, now - run.startedAt)
          const deadlineMinutes = Math.max(0, Math.ceil((run.deadlineAt - now) / 60000))
          const urgent = run.deadlineAt - now < 600000
          const overdue = run.typicalDurationMs !== null && elapsed > run.typicalDurationMs
          const tone = urgent ? 'text-red-600' : overdue ? 'text-orange-600' : 'text-sky-600'
          const bar = urgent ? 'bg-red-500' : overdue ? 'bg-orange-500' : 'bg-sky-500'
          const filled = run.typicalDurationMs ? Math.min(12, Math.floor((elapsed / run.typicalDurationMs) * 12)) : 0
          return (
            <div key={run.runId} className="flex items-start gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => navigate(scheduleDetailPath({ ...run, returnTo }))}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bar}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{run.jobName}</span>
                  <span className={`font-mono tabular-nums ${tone}`}>{formatElapsed(elapsed)}</span>
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {run.repoName} · {run.agentSlug ?? t('default agent')}
                </span>
                {run.typicalDurationMs === null ? (
                  <span className="mt-2 block text-xs text-muted-foreground">{t('No history')}</span>
                ) : (
                  <>
                    <span className="mt-2 flex gap-0.5" aria-hidden="true">
                      {Array.from({ length: 12 }, (_, index) => (
                        <span key={index} className={`h-1.5 flex-1 rounded-sm ${index < filled ? bar : 'bg-muted'}`} />
                      ))}
                    </span>
                    <span className={`mt-1 block text-xs tabular-nums ${tone}`}>
                      {formatElapsed(elapsed)} / ~{formatDuration(run.typicalDurationMs)}
                    </span>
                  </>
                )}
                {urgent ? (
                  <span className={`block text-xs ${tone}`}>{t('Deadline in {m}m', { m: deadlineMinutes })}</span>
                ) : overdue ? (
                  <span className={`block text-xs ${tone}`}>{t('Running longer than usual')}</span>
                ) : null}
              </button>
              {run.sessionId && (
                <Link
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-accent"
                  to={scheduleSessionPath(run, run.sessionId)}
                  aria-label={t('Open session')}
                >
                  <SquareArrowOutUpRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <h2 className="text-sm font-semibold">{t('Next up')}</h2>
        <div className="mt-3 space-y-2">
          {!upcoming.length && (
            <p className="text-xs text-muted-foreground">{t('No runs scheduled in the next 7 days.')}</p>
          )}
          {[...upcoming]
            .sort((left, right) => left.at - right.at)
            .slice(0, 8)
            .map((job) => (
              <div key={`${job.jobId}-${job.at}`} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {isSameDay(job.at, now) ? formatTime(job.at) : formatMonthDayTime(job.at)}
                </span>
                <span className="min-w-0 flex-1 truncate">{job.name}</span>
                <span className="text-muted-foreground">{t(job.kind)}</span>
              </div>
            ))}
        </div>
      </div>
    </section>
  )
}
