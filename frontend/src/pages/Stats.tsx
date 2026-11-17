import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChartColumnBig, Layers, RefreshCw } from 'lucide-react'
import type {
  TokenSplit,
  TokenStatsBucket,
  TokenStatsFilter,
  TokenStatsResponse,
  TokenStatsRow,
} from '@opencode-manager/shared/schemas'
import { Header } from '@/components/ui/header'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PendingActionsGroup } from '@/components/notifications/PendingActionsGroup'
import { TokenStatsChart } from '@/components/stats/TokenStatsChart'
import { StatsFilterBar } from '@/components/stats/StatsFilterBar'
import { StatsBreakdown } from '@/components/stats/StatsBreakdown'
import { StatsKpiGrid } from '@/components/stats/StatsKpiGrid'
import { WorkflowView } from '@/components/stats/WorkflowView'
import { buildKpiCards } from '@/lib/statsKpis'
import { t } from '@/i18n/translate'
import { intlLocale } from '@/i18n/format'
import { useStatsAutoRefresh, useTokenStats } from '@/hooks/useTokenStats'
import { useMobile } from '@/hooks/useMobile'
import { cn } from '@/lib/utils'
import {
  DIMENSION_LABELS,
  RANGE_SHORT_LABELS,
  SPLIT_OPTIONS,
  STATS_RANGES,
  STATS_TABS,
  TAB_LABELS,
  apiCost,
  formatAge,
  formatCompactCost,
  formatDelta,
  formatInteger,
  formatRangeSubtitle,
  formatShare,
  formatTokens,
  ratio,
  readStatsViewState,
  seriesColor,
  isStatsTab,
  statsTabState,
  toggleFilter,
  writeStatsViewState,
  type StatsChartMode,
  type StatsMetric,
  type StatsRange,
  type StatsTab,
  type StatsViewState,
} from '@/lib/tokenStats'

const FRESH_DATA_MS = 5 * 60_000
const AGE_TICK_MS = 15_000

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  format: (value: T) => string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 overflow-hidden rounded-md border border-border bg-card"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'whitespace-nowrap border-r border-border px-2.5 py-1.5 text-xs font-medium transition-colors last:border-r-0 sm:px-3',
            value === option
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {format(option)}
        </button>
      ))}
    </div>
  )
}

function StatusChip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground"
    >
      {children}
    </span>
  )
}

function Panel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4', className)}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
              <span className="truncate">{title}</span>
              {subtitle && (
                <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">{subtitle}</span>
              )}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

function Legend({ data, splitBy }: { data: TokenStatsResponse; splitBy: TokenSplit }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {data.series.map((item, index) => {
        const total = data.buckets.reduce((sum, bucket) => sum + (bucket.values[index] ?? 0), 0)
        return (
          <span key={item.key} className="flex min-w-0 items-center gap-1.5 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: seriesColor(item.key, index, splitBy) }}
            />
            <span className="max-w-40 truncate">
              {splitBy === 'tokenType' || item.key === '__other' ? t(item.label) : item.label}
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">{formatTokens(total)}</span>
          </span>
        )
      })}
    </div>
  )
}

function Coverage({ data }: { data: TokenStatsResponse }) {
  const attributed = data.totals.total > 0 ? data.attribution.accountTokens / data.totals.total : 0
  const date = (value: number) =>
    new Date(value).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const rows: [string, string][] = [
    [t('Account attribution'), data.totals.total > 0 ? formatShare(attributed) : '—'],
    [
      t('Account tracking'),
      data.attribution.trackedSince
        ? t('since {date}', { date: date(data.attribution.trackedSince) })
        : t('after the first CLIProxy request'),
    ],
    [t('Responses indexed'), formatInteger(data.index.messages)],
    [t('History from'), data.index.firstMessageAt ? date(data.index.firstMessageAt) : '—'],
    [t('Updated'), date(data.generatedAt)],
  ]
  return (
    <Panel title={t('Data coverage')}>
      <dl className="flex flex-col divide-y divide-border/60 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-2 first:pt-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-mono text-xs tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {t(
          'Usage comes from every assistant response stored by OpenCode 2. Responses before account tracking started are listed as before tracking, and responses that cannot be matched to exactly one CLIProxy account are listed as unattributed. CLIProxy usage events used for account matching are kept for 90 days.',
        )}
      </p>
      {data.totals.unpricedMessages > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t(
            'Unpriced responses: {count}. No API price was found for these responses; they contribute $0 to the API-equivalent cost.',
            { count: formatInteger(data.totals.unpricedMessages) },
          )}
        </p>
      )}
    </Panel>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function StatsTabs({
  value,
  badges,
  onChange,
}: {
  value: StatsTab
  badges: Partial<Record<StatsTab, string>>
  onChange: (tab: StatsTab) => void
}) {
  return (
    <div
      role="tablist"
      aria-label={t('Statistics sections')}
      className="-mx-3 flex overflow-x-auto border-b border-border px-3 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {STATS_TABS.map((tab) => {
        const selected = value === tab
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 px-3 pb-2.5 pt-1.5 text-sm transition-colors',
              selected ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(TAB_LABELS[tab])}
            {badges[tab] && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                {badges[tab]}
              </span>
            )}
            {selected && (
              <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" />
            )}
          </button>
        )
      })}
    </div>
  )
}

interface ChartSeries {
  readonly series: readonly { key: string; label: string }[]
  readonly buckets: readonly TokenStatsBucket[]
  readonly splitBy: TokenSplit
  readonly formatValue: (value: number) => string
}

function chartSeries(data: TokenStatsResponse, state: StatsViewState): ChartSeries {
  if (state.metric === 'cost') {
    return {
      series: [{ key: 'cost', label: t('API-equivalent cost') }],
      buckets: data.buckets.map((bucket) => ({ ...bucket, values: [apiCost(bucket)], total: apiCost(bucket) })),
      splitBy: 'model',
      formatValue: formatCompactCost,
    }
  }
  if (state.chartMode === 'total') {
    return {
      series: [{ key: 'total', label: t('Total') }],
      buckets: data.buckets.map((bucket) => ({ ...bucket, values: [bucket.total] })),
      splitBy: 'model',
      formatValue: formatTokens,
    }
  }
  return { series: data.series, buckets: data.buckets, splitBy: state.splitBy, formatValue: formatTokens }
}

function ChartPanel({
  data,
  state,
  isMobile,
  update,
}: {
  data: TokenStatsResponse
  state: StatsViewState
  isMobile: boolean
  update: (patch: Partial<StatsViewState>) => void
}) {
  const chart = chartSeries(data, state)
  const stacked = state.metric === 'tokens' && state.chartMode === 'stack'
  const interval = t(data.interval)
  const title =
    state.metric === 'cost' ? t('Cost per {interval}', { interval }) : t('Tokens per {interval}', { interval })
  const subtitle =
    data.interval === 'day'
      ? t('{count}d', { count: data.buckets.length })
      : t('{count}h', { count: data.buckets.length })
  const modes: readonly { mode: StatsChartMode; label: string; icon: typeof Layers }[] = [
    { mode: 'total', label: t('Show totals'), icon: ChartColumnBig },
    { mode: 'stack', label: t('Show stacked series'), icon: Layers },
  ]
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      action={
        <div className="flex w-full min-w-0 items-center justify-between gap-2 sm:w-auto sm:justify-end">
          {stacked && (
            <div className="-mx-1 min-w-0 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <SegmentedControl
                label={t('Split chart by')}
                value={state.splitBy}
                options={SPLIT_OPTIONS}
                onChange={(splitBy: TokenSplit) => update({ splitBy })}
                format={(split) => t(split === 'tokenType' ? 'Type' : DIMENSION_LABELS[split])}
              />
            </div>
          )}
          {state.metric === 'tokens' && (
            <div
              role="radiogroup"
              aria-label={t('Chart style')}
              className="flex shrink-0 overflow-hidden rounded-md border border-border"
            >
              {modes.map(({ mode, label, icon: Icon }) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={state.chartMode === mode}
                  aria-label={label}
                  title={label}
                  onClick={() => update({ chartMode: mode })}
                  className={cn(
                    'flex h-7 w-8 items-center justify-center border-r border-border last:border-r-0 transition-colors',
                    state.chartMode === mode
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          )}
        </div>
      }
    >
      <TokenStatsChart
        buckets={chart.buckets}
        series={chart.series}
        interval={data.interval}
        splitBy={chart.splitBy}
        height={isMobile ? 200 : 240}
        formatValue={chart.formatValue}
      />
      {stacked && <Legend data={data} splitBy={state.splitBy} />}
    </Panel>
  )
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function Stats() {
  const isMobile = useMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useMemo(() => readStatsViewState(searchParams), [searchParams])
  const [autoRefresh, setAutoRefresh] = useStatsAutoRefresh()
  const workflowRange = state.range === '24h' || state.range === '7d' ? state.range : '30d'
  const displayedRange = state.view === 'workflow' ? workflowRange : state.range
  const ranges = state.view === 'workflow' ? (['24h', '7d', '30d'] as const) : STATS_RANGES
  const rangeLabel = (range: StatsRange) => t(RANGE_SHORT_LABELS[range])
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useTokenStats(state, autoRefresh)
  const now = useNow(AGE_TICK_MS)

  const update = useCallback(
    (patch: Partial<StatsViewState>) => {
      setSearchParams(writeStatsViewState({ ...state, ...patch }), { replace: true })
    },
    [setSearchParams, state],
  )

  const handleToggleFilter = useCallback(
    (filter: TokenStatsFilter) => update({ filters: toggleFilter(state.filters, filter) }),
    [update, state.filters],
  )
  const handleSelectRow = useCallback(
    (row: TokenStatsRow) => {
      if (state.groupBy === 'day') return
      handleToggleFilter({ dimension: state.groupBy, value: row.key })
    },
    [handleToggleFilter, state.groupBy],
  )

  const selectedKeys = useMemo(
    () => new Set(state.filters.filter((filter) => filter.dimension === state.groupBy).map((filter) => filter.value)),
    [state.filters, state.groupBy],
  )
  const previousComplete = data
    ? data.index.firstMessageAt !== null && data.index.firstMessageAt <= data.from - (data.to - data.from)
    : false
  const delta =
    data && previousComplete && state.range !== 'all'
      ? (formatDelta(data.totals.total, data.previous.total) ?? undefined)
      : undefined
  const cards = useMemo(() => (data ? buildKpiCards(data, delta) : []), [data, delta])
  const coverage =
    data && data.totals.total > 0 ? formatShare(ratio(data.attribution.accountTokens, data.totals.total)) : undefined
  const age = dataUpdatedAt > 0 ? Math.max(0, now - dataUpdatedAt) : undefined
  const badges: Partial<Record<StatsTab, string>> = data
    ? { overview: formatTokens(data.totals.total), ...(coverage ? { account: coverage } : {}) }
    : {}
  const tokensView = state.view === 'tokens'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <Header>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Header.Title className="shrink-0">{tokensView ? t('Token usage') : t('Workflow')}</Header.Title>
          {tokensView && data && (
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              {age === undefined ? (
                <StatusChip label={t('Updating statistics')}>{t('Updating statistics')}</StatusChip>
              ) : (
                <StatusChip label={t('Last synced {age} ago', { age: formatAge(age) })}>
                  <span
                    aria-hidden
                    className={cn('h-1.5 w-1.5 rounded-full', age < FRESH_DATA_MS ? 'bg-success' : 'bg-warning')}
                  />
                  {t('Synced')}
                  <span className={age < FRESH_DATA_MS ? 'text-success' : 'text-warning'}>{formatAge(age)}</span>
                </StatusChip>
              )}
              {coverage && (
                <StatusChip label={t('Account coverage {share}', { share: coverage })}>
                  {t('Coverage')}
                  <span className="text-foreground">{coverage}</span>
                </StatusChip>
              )}
            </div>
          )}
        </div>
        {!isMobile && (
          <Header.Actions>
            <PendingActionsGroup />
          </Header.Actions>
        )}
      </Header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 sm:px-6 sm:pb-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="-mx-3 max-w-full overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:px-0">
              <SegmentedControl
                label={t('Date range')}
                value={displayedRange}
                options={ranges}
                onChange={(range: StatsRange) => update({ range })}
                format={rangeLabel}
              />
            </div>
            {tokensView && (
              <>
                <SegmentedControl
                  label={t('Metric')}
                  value={state.metric}
                  options={['tokens', 'cost'] as const}
                  onChange={(metric: StatsMetric) => update({ metric })}
                  format={(metric) => (metric === 'tokens' ? t('Tokens') : t('Cost'))}
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label={t('Auto refresh')} />
                  {t('Auto')}
                </label>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => void refetch()}
                  aria-label={t('Refresh statistics')}
                  disabled={isFetching}
                >
                  <RefreshCw className={cn('h-4 w-4', isFetching && 'motion-safe:animate-spin')} />
                </Button>
                {data && (
                  <span className="text-xs text-muted-foreground">{formatRangeSubtitle(data.from, data.to)}</span>
                )}
              </>
            )}
          </div>

          <StatsTabs value={state.tab} badges={badges} onChange={(tab) => update(statsTabState(tab))} />

          {state.view === 'workflow' ? (
            <WorkflowView range={workflowRange} />
          ) : (
            <>
              <StatsFilterBar
                filters={state.filters}
                facets={data?.facets ?? {}}
                onToggle={handleToggleFilter}
                onClear={() => update({ filters: [] })}
              />

              {isLoading && !data ? (
                <LoadingState />
              ) : isError && !data ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-border py-16 text-center">
                  <p className="text-sm font-medium">{t('Statistics are unavailable')}</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    {t(
                      'The Manager backend did not return token statistics. It may need a restart to load this feature.',
                    )}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    {t('Retry')}
                  </Button>
                </div>
              ) : data && state.tab === 'overview' ? (
                <>
                  <StatsKpiGrid cards={cards} />
                  <p className="text-[11px] text-muted-foreground">
                    {t(
                      '* API-rate equivalent: OpenCode-recorded cost plus models.dev estimates for usage recorded at $0 (subscription/OAuth). Not a subscription bill.',
                    )}
                  </p>
                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
                    <ChartPanel data={data} state={state} isMobile={isMobile} update={update} />
                    <Coverage data={data} />
                  </div>
                </>
              ) : data ? (
                <>
                  <ChartPanel data={data} state={state} isMobile={isMobile} update={update} />
                  <StatsBreakdown
                    groupBy={state.groupBy}
                    rows={data.breakdown}
                    selectedKeys={selectedKeys}
                    onGroupByChange={(groupBy) => {
                      if (isStatsTab(groupBy)) update(statsTabState(groupBy))
                    }}
                    onSelectRow={handleSelectRow}
                    isMobile={isMobile}
                    showGroupTabs={false}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
