import type { TokenGroupDimension, TokenStatsRow } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import {
  BREAKDOWN_DIMENSIONS,
  DIMENSION_LABELS,
  apiCost,
  formatCost,
  formatCostSplit,
  formatInteger,
  formatShare,
  formatTokens,
} from '@/lib/tokenStats'

interface StatsBreakdownProps {
  groupBy: TokenGroupDimension
  rows: readonly TokenStatsRow[]
  selectedKeys: ReadonlySet<string>
  onGroupByChange: (dimension: TokenGroupDimension) => void
  onSelectRow: (row: TokenStatsRow) => void
  isMobile: boolean
  showGroupTabs?: boolean
}

function ShareBar({ share }: { share: number }) {
  return (
    <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-foreground/70"
        style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
      />
    </div>
  )
}

export function StatsBreakdown({
  groupBy,
  rows,
  selectedKeys,
  onGroupByChange,
  onSelectRow,
  isMobile,
  showGroupTabs = true,
}: StatsBreakdownProps) {
  const clickable = groupBy !== 'day'
  return (
    <section aria-labelledby="stats-breakdown-title" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="stats-breakdown-title" className="text-sm font-semibold">
          {t('Breakdown')}
        </h2>
        {showGroupTabs && (
          <div
            role="tablist"
            aria-label={t('Group by')}
            className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
          >
            {BREAKDOWN_DIMENSIONS.map((dimension) => (
              <button
                key={dimension}
                type="button"
                role="tab"
                aria-selected={groupBy === dimension}
                onClick={() => onGroupByChange(dimension)}
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  groupBy === dimension ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(DIMENSION_LABELS[dimension])}
              </button>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border py-10 text-center text-sm text-muted-foreground">
          {t('No usage matches these filters')}
        </p>
      ) : isMobile ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onSelectRow(row)}
                className={cn(
                  'flex w-full flex-col gap-1.5 px-3 py-2.5 text-left',
                  clickable && 'active:bg-accent',
                  selectedKeys.has(row.key) && 'bg-accent',
                )}
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</span>
                  <span className="shrink-0 font-mono text-sm tabular-nums">{formatTokens(row.totals.total)}</span>
                </div>
                <ShareBar share={row.share} />
                <div className="flex justify-between gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                  <span className="truncate">
                    {row.detail ?? t('{count} msgs', { count: formatInteger(row.totals.messages) })}
                  </span>
                  <span className="shrink-0">
                    {formatShare(row.share)} · {formatCost(apiCost(row.totals))}
                  </span>
                </div>
                {row.totals.estimatedCost > 0 && (
                  <span className="text-[11px] text-muted-foreground">{formatCostSplit(row.totals)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="whitespace-nowrap border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t(DIMENSION_LABELS[groupBy])}
                </th>
                <th scope="col" className="w-36 px-3 py-2 font-medium">
                  {t('Share')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Input')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Cache read')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Output')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Total')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Cost')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('Msgs')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  onClick={clickable ? () => onSelectRow(row) : undefined}
                  className={cn(
                    'border-b border-border/60 last:border-0',
                    clickable && 'cursor-pointer hover:bg-accent/60',
                    selectedKeys.has(row.key) && 'bg-accent',
                  )}
                >
                  <td className="max-w-80 px-3 py-2">
                    {clickable ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelectRow(row)
                        }}
                        className="block max-w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={t('Filter by {label}', { label: row.label })}
                      >
                        <span className="block truncate font-medium">{row.label}</span>
                        {row.detail && (
                          <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                        )}
                      </button>
                    ) : (
                      <span className="font-mono">{row.label}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <ShareBar share={row.share} />
                      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {formatShare(row.share)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                    {formatTokens(row.totals.input)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatTokens(row.totals.cacheRead)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                    {formatTokens(row.totals.output + row.totals.reasoning)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums">
                    {formatTokens(row.totals.total)}
                  </td>
                  <td
                    className="px-3 py-2 text-right font-mono text-xs tabular-nums"
                    title={formatCostSplit(row.totals)}
                  >
                    {formatCost(apiCost(row.totals))}
                    {row.totals.estimatedCost > 0 && <span className="sr-only"> ({formatCostSplit(row.totals)})</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatInteger(row.totals.messages)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
