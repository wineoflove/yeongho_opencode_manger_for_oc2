import type { ScheduleRun } from '@opencode-manager/shared/types'
import type { ScheduleRunUsage, ScheduleUsageTotals } from '@opencode-manager/shared/schemas'
import { formatNumber } from '@/i18n/format'
import { msg, t } from '@/i18n/translate'
import { OutcomeBadge } from './OutcomeBadge'

const DELIVERIES = {
  published: msg('Published'),
  already_published: msg('Already published'),
  failed: msg('Failed'),
  not_applicable: msg('Not applicable'),
}

function totalTokens(usage: ScheduleUsageTotals): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

function formatUsage(usage: ScheduleUsageTotals): string {
  return t('{tokens} tokens · {cost}', {
    tokens: formatNumber(totalTokens(usage)),
    cost: formatNumber(usage.cost, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
  })
}

function UsageTotals({ usage }: { readonly usage: ScheduleRunUsage }) {
  if (usage.error === null) return formatUsage(usage.totals)
  if (usage.sessions === 0) return <span className="text-muted-foreground">{t('Usage unavailable')}</span>
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      <span className="text-muted-foreground">{t('Usage incomplete')}</span>
      <span>{formatUsage(usage.totals)}</span>
    </span>
  )
}

function formatWork(report: NonNullable<ScheduleRun['outcomeReport']>): string | null {
  const { processed, remaining, unit } = report
  if (processed !== undefined && remaining !== undefined) {
    return unit
      ? t('{processed} done · {remaining} left {unit}', { processed, remaining, unit })
      : t('{processed} done · {remaining} left', { processed, remaining })
  }
  if (processed !== undefined) return t('{processed} done', { processed })
  if (remaining !== undefined) {
    return unit ? t('{remaining} left {unit}', { remaining, unit }) : t('{remaining} left', { remaining })
  }
  return null
}

/** Summarizes the outcome a scheduled run reported through `report_outcome`, with its usage and agent. */
export function RunOutcomeSummary({ run }: { readonly run: ScheduleRun }) {
  const { outcome, outcomeReport: report, usage, agentUsed } = run
  if (!outcome && !report && !usage && !agentUsed) return null

  const missing = <span className="text-muted-foreground">{t('Not tracked')}</span>
  const work = report ? formatWork(report) : null
  const models = Object.entries(usage?.byModel ?? {})
    .sort(([, left], [, right]) => totalTokens(right) - totalTokens(left))
    .slice(0, 3)

  return (
    <section
      aria-label={t('Outcome')}
      className="max-h-[40%] shrink-0 space-y-2 overflow-y-auto border-b border-border/60 px-3 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{t('Outcome')}</h2>
        {outcome ? <OutcomeBadge outcome={outcome} /> : missing}
      </div>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2 [&>div]:min-w-0">
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">{t('Summary')}</dt>
          <dd className="[overflow-wrap:anywhere]">{report?.summary ?? missing}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('Work')}</dt>
          <dd className="tabular-nums">{work ?? missing}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('Report')}</dt>
          <dd>{report?.delivery ? t(DELIVERIES[report.delivery]) : missing}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">{t('Artifacts')}</dt>
          <dd className="[overflow-wrap:anywhere]">
            {report?.artifacts?.length ? (
              <ul className="min-w-0 space-y-1">
                {report.artifacts.map((artifact, index) => (
                  <li key={`${index}-${artifact}`} className="[overflow-wrap:anywhere]">
                    {artifact}
                  </li>
                ))}
              </ul>
            ) : (
              missing
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('Usage')}</dt>
          <dd className="tabular-nums">
            {usage ? <UsageTotals usage={usage} /> : missing}
            {models.length > 0 && (
              <>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {models.map(([model, totals]) => (
                    <li key={model} className="flex min-w-0 flex-wrap gap-x-2">
                      <span className="min-w-0 [overflow-wrap:anywhere]">{model}</span>
                      <span>{formatUsage(totals)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground break-keep">
                  {t(
                    'By model: stored assistant responses only. The total also includes title generation, compaction and reverted messages.',
                  )}
                </p>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('Agent')}</dt>
          <dd className="[overflow-wrap:anywhere]">{agentUsed ?? missing}</dd>
        </div>
      </dl>
    </section>
  )
}
