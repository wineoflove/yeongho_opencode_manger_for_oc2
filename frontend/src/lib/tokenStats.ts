import {
  TOKEN_FILTER_DIMENSIONS,
  TOKEN_GROUP_DIMENSIONS,
  type TokenFilterDimension,
  type TokenGroupDimension,
  type TokenSplit,
  type TokenStatsFilter,
  type TokenTotals,
} from '@opencode-manager/shared/schemas'
import { msg, t } from '@/i18n/translate'
import { formatDate, formatMonthDayTime, formatNumber, intlLocale } from '@/i18n/format'
import { getLocale } from '@/i18n/locale'

export const STATS_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
export type StatsRange = (typeof STATS_RANGES)[number]

export const RANGE_LABELS: Record<StatsRange, string> = {
  '24h': msg('24 hours'),
  '7d': msg('7 days'),
  '30d': msg('30 days'),
  '90d': msg('90 days'),
  all: msg('All time'),
}
export const RANGE_SHORT_LABELS: Record<StatsRange, string> = {
  '24h': msg('24h'),
  '7d': msg('7d'),
  '30d': msg('30d'),
  '90d': msg('90d'),
  all: msg('All'),
}

export const DIMENSION_LABELS: Record<TokenGroupDimension, string> = {
  model: msg('Model'),
  provider: msg('Provider'),
  account: msg('Account'),
  project: msg('Project'),
  agent: msg('Agent'),
  category: msg('Category'),
  session: msg('Session'),
  day: msg('Day'),
}

export const BREAKDOWN_DIMENSIONS: readonly TokenGroupDimension[] = [
  'model',
  'project',
  'agent',
  'category',
  'session',
  'day',
]
export const SPLIT_OPTIONS: readonly TokenSplit[] = ['tokenType', 'model', 'project', 'agent', 'category']
export const FILTER_MENU_DIMENSIONS: readonly TokenFilterDimension[] = [
  'model',
  'provider',
  'project',
  'agent',
  'category',
  'session',
]

const DAY_MS = 86_400_000
const RANGE_MS: Record<Exclude<StatsRange, 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
}

export const STATS_TABS = [
  'overview',
  'model',
  'provider',
  'project',
  'agent',
  'category',
  'session',
  'day',
  'workflow',
] as const
export type StatsTab = (typeof STATS_TABS)[number]
export type StatsMetric = 'tokens' | 'cost'
export type StatsChartMode = 'stack' | 'total'

export const TAB_LABELS: Record<StatsTab, string> = {
  overview: msg('Overview'),
  ...DIMENSION_LABELS,
  workflow: msg('Workflow'),
}

export interface StatsViewState {
  readonly tab: StatsTab
  readonly view: 'tokens' | 'workflow'
  readonly range: StatsRange
  readonly groupBy: TokenGroupDimension
  readonly splitBy: TokenSplit
  readonly metric: StatsMetric
  readonly chartMode: StatsChartMode
  readonly filters: readonly TokenStatsFilter[]
}

export function rangeWindow(range: StatsRange, now: number): { from: number; to: number } {
  const to = Math.ceil(now / 60_000) * 60_000
  return { from: range === 'all' ? 0 : to - RANGE_MS[range], to }
}

function isOneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return value !== null && (values as readonly string[]).includes(value)
}

export function statsTabState(tab: StatsTab): Pick<StatsViewState, 'tab' | 'view' | 'groupBy'> {
  return {
    tab,
    view: tab === 'workflow' ? 'workflow' : 'tokens',
    groupBy: isOneOf(TOKEN_GROUP_DIMENSIONS, tab) ? tab : 'model',
  }
}

export function isStatsTab(value: string | null): value is StatsTab {
  return isOneOf(STATS_TABS, value)
}

function readTab(params: URLSearchParams): StatsTab {
  if (params.get('view') === 'workflow') return 'workflow'
  const tab = params.get('tab')
  if (isOneOf(STATS_TABS, tab)) return tab
  const legacyGroup = params.get('groupBy')
  return isStatsTab(legacyGroup) ? legacyGroup : 'overview'
}

export function readStatsViewState(params: URLSearchParams): StatsViewState {
  const range = params.get('range')
  const splitBy = params.get('splitBy')
  const filters: TokenStatsFilter[] = []
  for (const raw of params.getAll('f')) {
    const separator = raw.indexOf(':')
    const dimension = raw.slice(0, Math.max(0, separator))
    const value = raw.slice(separator + 1)
    if (
      separator > 0 &&
      value &&
      isOneOf(TOKEN_FILTER_DIMENSIONS, dimension) &&
      !filters.some((filter) => filter.dimension === dimension && filter.value === value)
    ) {
      filters.push({ dimension, value })
    }
  }
  return {
    ...statsTabState(readTab(params)),
    range: isOneOf(STATS_RANGES, range) ? range : '30d',
    splitBy: splitBy === 'tokenType' || isOneOf(TOKEN_FILTER_DIMENSIONS, splitBy) ? splitBy : 'tokenType',
    metric: params.get('metric') === 'cost' ? 'cost' : 'tokens',
    chartMode: params.get('chart') === 'total' ? 'total' : 'stack',
    filters,
  }
}

export function writeStatsViewState(state: StatsViewState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.tab !== 'overview') params.set('tab', state.tab)
  if (state.range !== '30d') params.set('range', state.range)
  if (state.splitBy !== 'tokenType') params.set('splitBy', state.splitBy)
  if (state.metric === 'cost') params.set('metric', state.metric)
  if (state.chartMode === 'total') params.set('chart', state.chartMode)
  for (const filter of state.filters) params.append('f', `${filter.dimension}:${filter.value}`)
  return params
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

export function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

export function toggleFilter(filters: readonly TokenStatsFilter[], filter: TokenStatsFilter): TokenStatsFilter[] {
  const exists = filters.some((item) => item.dimension === filter.dimension && item.value === filter.value)
  return exists
    ? filters.filter((item) => item.dimension !== filter.dimension || item.value !== filter.value)
    : [...filters, filter]
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9)
    return `${formatNumber(Number((value / 1e9).toFixed(abs >= 1e10 ? 1 : 2)), { minimumFractionDigits: abs >= 1e10 ? 1 : 2, maximumFractionDigits: abs >= 1e10 ? 1 : 2, useGrouping: false })}B`
  if (abs >= 1e6)
    return `${formatNumber(Number((value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)), { minimumFractionDigits: abs >= 1e7 ? 1 : 2, maximumFractionDigits: abs >= 1e7 ? 1 : 2, useGrouping: false })}M`
  if (abs >= 1e3)
    return `${formatNumber(Number((value / 1e3).toFixed(1)), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })}K`
  return formatNumber(Math.round(value), { useGrouping: false })
}

const COST_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCost(value: number): string {
  return COST_FORMAT.format(value)
}

export function formatCompactCost(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(abs > 0 && abs < 10 ? 2 : 0)}`
}

export function apiCost(totals: Pick<TokenTotals, 'cost' | 'estimatedCost'>): number {
  return totals.cost + totals.estimatedCost
}

export function formatCostSplit(totals: Pick<TokenTotals, 'cost' | 'estimatedCost'>): string | undefined {
  return totals.estimatedCost > 0
    ? t('recorded {recorded} + estimated {estimated}', {
        recorded: formatCost(totals.cost),
        estimated: formatCost(totals.estimatedCost),
      })
    : undefined
}

export function formatInteger(value: number): string {
  return formatNumber(value)
}

export function formatShare(share: number): string {
  if (share > 0 && share < 0.001) return '<0.1%'
  return `${(share * 100).toFixed(1)}%`
}

export function formatDelta(
  current: number,
  previous: number,
): { text: string; direction: 'up' | 'down' | 'flat' } | null {
  if (previous <= 0) return null
  const change = (current - previous) / previous
  if (Math.abs(change) < 0.0005) return { text: '0.0%', direction: 'flat' }
  return {
    text: `${change > 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(1)}%`,
    direction: change > 0 ? 'up' : 'down',
  }
}

export function formatBucketLabel(start: number, interval: 'hour' | 'day'): string {
  const date = new Date(start)
  if (interval === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function formatBucketTitle(start: number, interval: 'hour' | 'day'): string {
  if (getLocale() === 'ko') return interval === 'hour' ? formatMonthDayTime(start) : formatDate(start)
  const date = new Date(start)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return interval === 'hour' ? `${day} ${String(date.getHours()).padStart(2, '0')}:00` : day
}

export function formatRangeSubtitle(from: number, to: number): string {
  const format = (value: number) => new Date(value).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' })
  return t('{from} to {to}', { from: format(from), to: format(to - 1) })
}

export const SERIES_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
] as const

export const TOKEN_TYPE_COLORS: Record<string, string> = {
  input: 'var(--color-chart-1)',
  cacheRead: 'var(--color-chart-2)',
  cacheWrite: 'var(--color-chart-5)',
  output: 'var(--color-chart-3)',
  reasoning: 'var(--color-chart-4)',
}

export function seriesColor(key: string, index: number, splitBy: TokenSplit): string {
  if (splitBy === 'tokenType') return TOKEN_TYPE_COLORS[key] ?? 'var(--color-chart-other)'
  if (key === '__other') return 'var(--color-chart-other)'
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? 'var(--color-chart-other)'
}

export function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return step * magnitude
}
