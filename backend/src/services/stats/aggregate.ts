import {
  TOKEN_FILTER_DIMENSIONS,
  TOKEN_TYPES,
  type TokenFilterDimension,
  type TokenGroupDimension,
  type TokenStatsBucket,
  type TokenStatsFacetValue,
  type TokenStatsQuery,
  type TokenStatsResponse,
  type TokenStatsRow,
  type TokenTotals,
} from '@opencode-manager/shared/schemas'
import { estimateRecordCost, type CostEstimate, type PriceTable } from './pricing'

type PricedUsageRecord = UsageRecord & CostEstimate

export interface UsageRecord {
  readonly messageId: string
  readonly rootSessionId: string
  readonly createdAt: number
  readonly keys: Readonly<Record<TokenFilterDimension, string>>
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
}

export interface DimensionLabel {
  readonly label: string
  readonly detail?: string
}

export type LabelResolver = (dimension: TokenFilterDimension, key: string) => DimensionLabel

export interface UsageIndexSnapshot {
  readonly records: readonly UsageRecord[]
  readonly label: LabelResolver
  readonly isAttributedAccount: (key: string) => boolean
  readonly trackedSince: number | null
  readonly firstMessageAt: number | null
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const HOURLY_RANGE_LIMIT_MS = 2 * DAY_MS
const SPLIT_SERIES_LIMIT = 6
const BREAKDOWN_LIMIT = 100
const FACET_LIMIT = 40
const OTHER_KEY = '__other'

const TOKEN_TYPE_LABELS: Record<(typeof TOKEN_TYPES)[number], string> = {
  input: 'Input',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  output: 'Output',
  reasoning: 'Reasoning',
}

export function recordTotal(record: UsageRecord): number {
  return record.input + record.output + record.reasoning + record.cacheRead + record.cacheWrite
}

class TotalsAccumulator {
  input = 0
  output = 0
  reasoning = 0
  cacheRead = 0
  cacheWrite = 0
  cost = 0
  estimatedCost = 0
  unpricedMessages = 0
  messages = 0
  private readonly sessions = new Set<string>()

  add(record: PricedUsageRecord): void {
    this.input += record.input
    this.output += record.output
    this.reasoning += record.reasoning
    this.cacheRead += record.cacheRead
    this.cacheWrite += record.cacheWrite
    this.cost += record.cost
    this.estimatedCost += record.estimatedCost
    this.unpricedMessages += record.unpricedMessages
    this.messages += 1
    this.sessions.add(record.rootSessionId)
  }

  get total(): number {
    return this.input + this.output + this.reasoning + this.cacheRead + this.cacheWrite
  }

  toTotals(): TokenTotals {
    return {
      input: this.input,
      output: this.output,
      reasoning: this.reasoning,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      total: this.total,
      cost: Math.round(this.cost * 10_000) / 10_000,
      estimatedCost: this.estimatedCost,
      unpricedMessages: this.unpricedMessages,
      messages: this.messages,
      sessions: this.sessions.size,
    }
  }
}

export function localBucketStart(timestamp: number, interval: 'hour' | 'day', tzOffsetMinutes: number): number {
  const offset = tzOffsetMinutes * 60_000
  const size = interval === 'hour' ? HOUR_MS : DAY_MS
  return Math.floor((timestamp + offset) / size) * size - offset
}

function localDayKey(timestamp: number, tzOffsetMinutes: number): string {
  return new Date(localBucketStart(timestamp, 'day', tzOffsetMinutes) + tzOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10)
}

type FilterSets = Map<TokenFilterDimension, Set<string>>

function toFilterSets(query: TokenStatsQuery): FilterSets {
  const sets: FilterSets = new Map()
  for (const { dimension, value } of query.filters) {
    const set = sets.get(dimension) ?? new Set<string>()
    set.add(value)
    sets.set(dimension, set)
  }
  return sets
}

function matches(record: UsageRecord, filters: FilterSets, except?: TokenFilterDimension): boolean {
  for (const [dimension, values] of filters) {
    if (dimension !== except && !values.has(record.keys[dimension])) return false
  }
  return true
}

function inRange(record: UsageRecord, from: number, to: number): boolean {
  return record.createdAt >= from && record.createdAt < to
}

function groupKey(record: UsageRecord, dimension: TokenGroupDimension, tzOffsetMinutes: number): string {
  return dimension === 'day' ? localDayKey(record.createdAt, tzOffsetMinutes) : record.keys[dimension]
}

function totalsByKey(
  records: readonly PricedUsageRecord[],
  keyOf: (record: UsageRecord) => string,
): Map<string, TotalsAccumulator> {
  const groups = new Map<string, TotalsAccumulator>()
  for (const record of records) {
    const key = keyOf(record)
    let group = groups.get(key)
    if (!group) {
      group = new TotalsAccumulator()
      groups.set(key, group)
    }
    group.add(record)
  }
  return groups
}

function emptyBucket(start: number, seriesCount: number): TokenStatsBucket {
  return {
    start,
    values: Array.from({ length: seriesCount }, () => 0),
    total: 0,
    cost: 0,
    estimatedCost: 0,
    unpricedMessages: 0,
    messages: 0,
    sessions: 0,
    accountTokens: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    providers: {},
  }
}

function buildBuckets(
  records: readonly PricedUsageRecord[],
  query: TokenStatsQuery,
  bucketFrom: number,
  interval: 'hour' | 'day',
  series: readonly { key: string }[],
  valueOf: (record: UsageRecord, seriesIndex: number) => number,
  isAttributedAccount: (key: string) => boolean,
): TokenStatsBucket[] {
  const size = interval === 'hour' ? HOUR_MS : DAY_MS
  const first = localBucketStart(bucketFrom, interval, query.tzOffsetMinutes)
  const buckets: TokenStatsBucket[] = []
  const sessions: Set<string>[] = []
  const indexByStart = new Map<number, number>()
  for (let start = first; start < query.to; start += size) {
    indexByStart.set(start, buckets.length)
    buckets.push(emptyBucket(start, series.length))
    sessions.push(new Set())
  }
  for (const record of records) {
    const index = indexByStart.get(localBucketStart(record.createdAt, interval, query.tzOffsetMinutes))
    const bucket = index === undefined ? undefined : buckets[index]
    if (index === undefined || !bucket) continue
    const total = recordTotal(record)
    bucket.values = bucket.values.map((value, seriesIndex) => value + valueOf(record, seriesIndex))
    bucket.total += total
    bucket.cost += record.cost
    bucket.estimatedCost += record.estimatedCost
    bucket.unpricedMessages += record.unpricedMessages
    bucket.messages += 1
    if (isAttributedAccount(record.keys.account)) bucket.accountTokens += total
    for (const type of TOKEN_TYPES) bucket.tokens[type] += record[type]
    bucket.providers[record.keys.provider] = (bucket.providers[record.keys.provider] ?? 0) + total
    sessions[index]?.add(record.rootSessionId)
  }
  return buckets.map((bucket, index) => ({ ...bucket, sessions: sessions[index]?.size ?? 0 }))
}

function toRow(key: string, group: TotalsAccumulator, grandTotal: number, label: DimensionLabel): TokenStatsRow {
  const totals = group.toTotals()
  return {
    key,
    label: label.label,
    ...(label.detail ? { detail: label.detail } : {}),
    totals,
    share: grandTotal > 0 ? totals.total / grandTotal : 0,
  }
}

export function aggregateTokenStats(
  snapshot: UsageIndexSnapshot,
  query: TokenStatsQuery,
  now: number,
  prices: PriceTable = new Map(),
): TokenStatsResponse {
  const records = snapshot.records.map((record) => ({ ...record, ...estimateRecordCost(record, prices) }))
  const filters = toFilterSets(query)
  const span = query.to - query.from
  const inWindow = records.filter((record) => inRange(record, query.from, query.to))
  const matched = inWindow.filter((record) => matches(record, filters))
  const previous = new TotalsAccumulator()
  for (const record of records) {
    if (inRange(record, query.from - span, query.from) && matches(record, filters)) previous.add(record)
  }

  const totals = new TotalsAccumulator()
  let accountTokens = 0
  for (const record of matched) {
    totals.add(record)
    if (snapshot.isAttributedAccount(record.keys.account)) accountTokens += recordTotal(record)
  }

  const bucketFrom = Math.min(query.to - 1, Math.max(query.from, snapshot.firstMessageAt ?? query.from))
  const interval = query.to - bucketFrom <= HOURLY_RANGE_LIMIT_MS ? 'hour' : 'day'
  let series: { key: string; label: string }[]
  let buckets: TokenStatsBucket[]
  if (query.splitBy === 'tokenType') {
    series = TOKEN_TYPES.map((type) => ({ key: type, label: TOKEN_TYPE_LABELS[type] }))
    buckets = buildBuckets(
      matched,
      query,
      bucketFrom,
      interval,
      series,
      (record, index) => record[TOKEN_TYPES[index] ?? 'input'],
      snapshot.isAttributedAccount,
    )
  } else {
    const dimension = query.splitBy
    const ranked = [...totalsByKey(matched, (record) => record.keys[dimension])].sort(
      ([, a], [, b]) => b.total - a.total,
    )
    const top = ranked.slice(0, SPLIT_SERIES_LIMIT).map(([key]) => key)
    const topIndex = new Map(top.map((key, index) => [key, index]))
    series = top.map((key) => ({ key, label: snapshot.label(dimension, key).label }))
    if (ranked.length > SPLIT_SERIES_LIMIT) series.push({ key: OTHER_KEY, label: 'Other' })
    buckets = buildBuckets(
      matched,
      query,
      bucketFrom,
      interval,
      series,
      (record, index) => {
        const position = topIndex.get(record.keys[dimension]) ?? SPLIT_SERIES_LIMIT
        return position === index ? recordTotal(record) : 0
      },
      snapshot.isAttributedAccount,
    )
  }

  const grandTotal = totals.total
  const grouped = [...totalsByKey(matched, (record) => groupKey(record, query.groupBy, query.tzOffsetMinutes))]
  const breakdown = (
    query.groupBy === 'day'
      ? grouped.sort(([a], [b]) => b.localeCompare(a))
      : grouped.sort(([, a], [, b]) => b.total - a.total)
  )
    .slice(0, BREAKDOWN_LIMIT)
    .map(([key, group]) =>
      toRow(key, group, grandTotal, query.groupBy === 'day' ? { label: key } : snapshot.label(query.groupBy, key)),
    )

  const facets = Object.fromEntries(
    TOKEN_FILTER_DIMENSIONS.map((dimension) => {
      const selected = filters.get(dimension) ?? new Set<string>()
      const ranked = [
        ...totalsByKey(
          inWindow.filter((record) => matches(record, filters, dimension)),
          (record) => record.keys[dimension],
        ),
      ].sort(([, a], [, b]) => b.total - a.total)
      const values: TokenStatsFacetValue[] = ranked
        .filter(([key], index) => index < FACET_LIMIT || selected.has(key))
        .map(([key, group]) => ({ key, label: snapshot.label(dimension, key).label, total: group.total }))
      for (const key of selected) {
        if (!values.some((value) => value.key === key))
          values.push({ key, label: snapshot.label(dimension, key).label, total: 0 })
      }
      return [dimension, values]
    }),
  ) as Record<TokenFilterDimension, TokenStatsFacetValue[]>

  return {
    generatedAt: now,
    from: bucketFrom,
    to: query.to,
    interval,
    totals: totals.toTotals(),
    previous: previous.toTotals(),
    series,
    buckets,
    breakdown,
    facets,
    attribution: { accountTokens, trackedSince: snapshot.trackedSince },
    index: { messages: snapshot.records.length, firstMessageAt: snapshot.firstMessageAt },
  }
}
