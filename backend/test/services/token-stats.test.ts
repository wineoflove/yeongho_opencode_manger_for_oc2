import { describe, expect, it } from 'vitest'
import { TokenStatsQuerySchema, type TokenStatsQuery } from '@opencode-manager/shared/schemas'
import {
  aggregateTokenStats,
  localBucketStart,
  type UsageIndexSnapshot,
  type UsageRecord,
} from '../../src/services/stats/aggregate'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 1)

function record(
  overrides: Partial<Omit<UsageRecord, 'keys'>> & { keys?: Partial<UsageRecord['keys']> } = {},
): UsageRecord {
  const { keys, ...rest } = overrides
  return {
    messageId: `msg_${Math.random()}`,
    rootSessionId: 'ses_root',
    createdAt: T0,
    input: 10,
    output: 5,
    reasoning: 0,
    cacheRead: 100,
    cacheWrite: 0,
    cost: 0.5,
    ...rest,
    keys: {
      model: 'anthropic/claude',
      provider: 'anthropic',
      account: 'anthropic:main',
      project: '/w/a',
      agent: 'Sisyphus',
      category: 'main',
      session: 'ses_root',
      ...keys,
    },
  }
}

function snapshot(records: UsageRecord[]): UsageIndexSnapshot {
  return {
    records,
    label: (dimension, key) => ({ label: `${dimension}:${key}` }),
    isAttributedAccount: (key) => !key.endsWith(':unattributed'),
    trackedSince: null,
    firstMessageAt: records.length > 0 ? Math.min(...records.map((item) => item.createdAt)) : null,
  }
}

function query(overrides: Partial<TokenStatsQuery> = {}): TokenStatsQuery {
  return TokenStatsQuerySchema.parse({ from: T0, to: T0 + 3 * DAY, ...overrides })
}

describe('aggregateTokenStats', () => {
  const records = [
    record({ createdAt: T0 + HOUR, keys: { model: 'anthropic/opus', agent: 'Sisyphus' } }),
    record({
      createdAt: T0 + DAY + HOUR,
      rootSessionId: 'ses_2',
      keys: {
        model: 'openai/gpt',
        provider: 'openai',
        account: 'openai:unattributed',
        agent: 'explore',
        category: '@explore',
        session: 'ses_2',
      },
    }),
    record({ createdAt: T0 + DAY + 2 * HOUR, keys: { model: 'anthropic/opus', agent: 'oracle' } }),
    record({ createdAt: T0 - DAY, input: 1000, keys: { model: 'anthropic/opus' } }),
  ]

  it('totals the window, compares the previous equal window and counts root sessions', () => {
    const result = aggregateTokenStats(snapshot(records), query(), T0)
    expect(result.totals).toMatchObject({
      input: 30,
      output: 15,
      cacheRead: 300,
      total: 345,
      messages: 3,
      sessions: 2,
      cost: 1.5,
    })
    expect(result.previous).toMatchObject({ input: 1000, messages: 1 })
    expect(result.attribution.accountTokens).toBe(230)
    expect(result.interval).toBe('day')
    expect(result.buckets.map((bucket) => bucket.total)).toEqual([115, 230, 0])
  })

  it('reports per-bucket messages, sessions, token types, providers and attributed tokens for sparklines', () => {
    const result = aggregateTokenStats(snapshot(records), query({ splitBy: 'model' }), T0)
    expect(
      result.buckets.map(({ messages, sessions, accountTokens, providers }) => ({
        messages,
        sessions,
        accountTokens,
        providers,
      })),
    ).toEqual([
      { messages: 1, sessions: 1, accountTokens: 115, providers: { anthropic: 115 } },
      { messages: 2, sessions: 2, accountTokens: 115, providers: { openai: 115, anthropic: 115 } },
      { messages: 0, sessions: 0, accountTokens: 0, providers: {} },
    ])
    expect(result.buckets[1]?.tokens).toEqual({ input: 20, cacheRead: 200, cacheWrite: 0, output: 10, reasoning: 0 })
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.messages, 0)).toBe(result.totals.messages)
  })

  it('combines filters with OR inside a dimension and AND across dimensions', () => {
    const both = aggregateTokenStats(
      snapshot(records),
      query({
        filters: [
          { dimension: 'agent', value: 'oracle' },
          { dimension: 'agent', value: 'explore' },
        ],
      }),
      T0,
    )
    expect(both.totals.messages).toBe(2)
    const narrowed = aggregateTokenStats(
      snapshot(records),
      query({
        filters: [
          { dimension: 'agent', value: 'oracle' },
          { dimension: 'agent', value: 'explore' },
          { dimension: 'provider', value: 'anthropic' },
        ],
      }),
      T0,
    )
    expect(narrowed.totals.messages).toBe(1)
    expect(narrowed.facets.agent.map((facet) => [facet.key, facet.total])).toEqual([
      ['Sisyphus', 115],
      ['oracle', 115],
      ['explore', 0],
    ])
    expect(Object.fromEntries(narrowed.facets.provider.map((facet) => [facet.key, facet.total]))).toEqual({
      anthropic: 115,
      openai: 115,
    })
  })

  it('splits the chart by a dimension and groups the table by day in local time', () => {
    const result = aggregateTokenStats(
      snapshot(records),
      query({ splitBy: 'model', groupBy: 'day', tzOffsetMinutes: 540 }),
      T0,
    )
    expect(result.series).toEqual([
      { key: 'anthropic/opus', label: 'model:anthropic/opus' },
      { key: 'openai/gpt', label: 'model:openai/gpt' },
    ])
    expect(result.buckets.reduce((sum, bucket) => sum + (bucket.values[0] ?? 0), 0)).toBe(230)
    expect(result.breakdown.map((row) => row.key)).toEqual(['2026-10-02', '2026-10-01'])
    expect(result.breakdown[0]?.share).toBeCloseTo(2 / 3)
  })

  it('uses hourly buckets for short windows aligned to the viewer time zone', () => {
    const result = aggregateTokenStats(snapshot(records), query({ to: T0 + DAY, tzOffsetMinutes: 540 }), T0)
    expect(result.interval).toBe('hour')
    expect(result.buckets[0]?.start).toBe(localBucketStart(T0, 'hour', 540))
    expect(localBucketStart(T0 + 2 * HOUR, 'day', 540)).toBe(T0 - 9 * HOUR)
  })

  it('starts all-time buckets at the first recorded message instead of the epoch', () => {
    const result = aggregateTokenStats(snapshot(records.slice(0, 3)), query({ from: 0, to: T0 + 3 * DAY }), T0)
    expect(result.from).toBe(T0 + HOUR)
    expect(result.buckets).toHaveLength(3)
  })

  it('keeps selected facet values visible even when nothing matches', () => {
    const result = aggregateTokenStats(
      snapshot(records),
      query({ filters: [{ dimension: 'model', value: 'gone/model' }] }),
      T0,
    )
    expect(result.totals.total).toBe(0)
    expect(result.facets.model.find((facet) => facet.key === 'gone/model')).toEqual({
      key: 'gone/model',
      label: 'model:gone/model',
      total: 0,
    })
  })
})

