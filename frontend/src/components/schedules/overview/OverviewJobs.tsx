import { Link } from 'react-router-dom'
import type { ScheduleOverviewJob } from '@opencode-manager/shared/schemas'
import { t, msg } from '@/i18n/translate'
import { formatMonthDayTime, formatPercent } from '@/i18n/format'
import { formatDuration, scheduleDetailPath } from '@/lib/scheduleOverview'
import { formatCost, formatTokens } from '@/lib/tokenStats'
import { OutcomeBadge } from '../OutcomeBadge'
import { RecentRunsStrip } from './RecentRunsStrip'

const headers = [
  msg('Job'),
  msg('Next run'),
  msg('Last result'),
  msg('Recent runs'),
  msg('Success'),
  msg('Avg time'),
  msg('Work'),
  msg('Tokens / run'),
  msg('Est. cost'),
  msg('Report'),
  msg('Warnings'),
]
const deliveries = {
  published: msg('Published'),
  already_published: msg('Already published'),
  failed: msg('Failed'),
  not_applicable: msg('Not applicable'),
}

function warnings(job: ScheduleOverviewJob): string[] {
  return [
    ...(job.agentStatus === 'unavailable' ? [t('Agent unavailable')] : []),
    ...(job.agentStatus === 'mismatch'
      ? [job.agentUsed ? t('Agent mismatch ({agentUsed})', { agentUsed: job.agentUsed }) : t('Agent mismatch')]
      : []),
    ...job.overlaps.map((overlap) =>
      t('Overlaps {name} at {time}', { name: overlap.name, time: formatMonthDayTime(overlap.at) }),
    ),
    ...(job.lastRun?.outcome === 'unreported' ? [t('Outcome not reported')] : []),
  ]
}

export function OverviewJobs({
  jobs,
  totalJobs,
  enabledJobs,
  returnTo,
}: {
  readonly jobs: readonly ScheduleOverviewJob[]
  readonly totalJobs: number
  readonly enabledJobs: number
  readonly returnTo: string
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">{t('Jobs')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('{total} jobs · {enabled} enabled · {warnings} with warnings', {
            total: totalJobs,
            enabled: enabledJobs,
            warnings: jobs.filter((job) => warnings(job).length).length,
          })}
        </p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('Recent runs')}: <span className="text-sky-600">{t('Running')}</span> ·{' '}
        <span className="text-green-600">{t('Succeeded')}</span> · <span className="text-red-600">{t('Failed')}</span> ·{' '}
        <span className="text-orange-600">{t('Unreported')}</span>
      </p>
      {!jobs.length ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('No schedules yet.')}</p>
      ) : (
        <div className="mt-4 @6xl:overflow-x-auto">
          <table className="block w-full text-left @6xl:table">
            <thead className="hidden text-xs text-muted-foreground @6xl:table-header-group">
              <tr>
                {headers.map((header) => (
                  <th key={header} scope="col" className="border-b border-border px-2 pb-2 font-medium">
                    {t(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="grid gap-3 @3xl:grid-cols-2 @6xl:table-row-group">
              {jobs.map((job) => {
                const missing = <span className="text-muted-foreground">{t('Not tracked')}</span>
                const cells = [
                  <Link
                    className="block min-w-0 font-medium hover:underline @6xl:w-0 @6xl:min-w-full"
                    title={job.name}
                    to={scheduleDetailPath({ ...job, returnTo })}
                  >
                    <span className="block truncate">{job.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{job.repoName}</span>
                  </Link>,
                  job.nextRunAt === null ? missing : formatMonthDayTime(job.nextRunAt),
                  job.lastRun ? (
                    <div>
                      <OutcomeBadge
                        outcome={job.lastRun.status === 'running' ? 'running' : (job.lastRun.outcome ?? 'unreported')}
                      />
                      <p className="mt-1 max-w-48 truncate text-xs text-muted-foreground @6xl:w-0 @6xl:min-w-full">
                        {job.lastRun.summary}
                      </p>
                    </div>
                  ) : (
                    missing
                  ),
                  <RecentRunsStrip runs={job.recentRuns} />,
                  job.successRate === null ? (
                    missing
                  ) : (
                    <span>
                      {formatPercent(job.successRate)} <span className="text-muted-foreground">({job.runs})</span>
                    </span>
                  ),
                  job.avgDurationMs === null ? missing : formatDuration(job.avgDurationMs),
                  job.processed === null && job.remaining === null
                    ? missing
                    : t('{processed} done · {remaining} left {unit}', {
                        processed: job.processed ?? t('Not tracked'),
                        remaining: job.remaining ?? t('Not tracked'),
                        unit: job.unit ?? '',
                      }),
                  job.usage?.perRunAvgTokens == null ? missing : formatTokens(job.usage.perRunAvgTokens),
                  job.usage?.estimatedCost == null ? missing : formatCost(job.usage.estimatedCost),
                  job.delivery === null ? missing : t(deliveries[job.delivery]),
                  <div className="space-y-1 text-xs text-orange-600">
                    {warnings(job).map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>,
                ]
                return (
                  <tr
                    key={job.jobId}
                    className="grid min-w-0 grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs tabular-nums @6xl:table-row @6xl:rounded-none @6xl:border-0 @6xl:border-b @6xl:p-0"
                  >
                    {cells.map((cell, index) => (
                      <td
                        key={headers[index]}
                        className={`block min-w-0 align-top @6xl:table-cell @6xl:min-w-24 @6xl:px-2 @6xl:py-3 ${index === 0 ? 'col-span-2 @6xl:min-w-40 @6xl:max-w-64' : ''}`}
                      >
                        {index > 0 && <p className="mb-1 text-muted-foreground @6xl:hidden">{t(headers[index])}</p>}
                        {cell}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
