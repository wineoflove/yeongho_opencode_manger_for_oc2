import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTokenStats } from './stats'
import { fetchWrapper } from './fetchWrapper'
import { buildKpiCards } from '../lib/statsKpis'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))

const totals = {
  input: 40,
  output: 10,
  cacheRead: 50,
  cacheWrite: 0,
  reasoning: 0,
  total: 100,
  cost: 1,
  estimatedCost: 0,
  unpricedMessages: 0,
  messages: 2,
  sessions: 1,
}
const legacy = {
  generatedAt: 2000,
  from: 1000,
  to: 2000,
  interval: 'day',
  totals,
  previous: totals,
  series: [{ key: 'input', label: 'Input' }],
  buckets: [{ start: 1000, values: [100], total: 100, cost: 1, estimatedCost: 0, unpricedMessages: 0 }],
  breakdown: [],
  facets: { model: [], provider: [], account: [], project: [], agent: [], category: [], session: [] },
  attribution: { accountTokens: 0, trackedSince: null },
  index: { messages: 2, firstMessageAt: 1000 },
}
const request = {
  from: 1000,
  to: 2000,
  tzOffsetMinutes: 0,
  groupBy: 'model',
  splitBy: 'tokenType',
  filters: [],
} as const

afterEach(() => vi.resetAllMocks())

describe('fetchTokenStats compatibility', () => {
  it('normalizes old buckets before KPI construction', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue(legacy)
    const data = await fetchTokenStats({ ...request, filters: [] })
    expect(data.buckets[0]).toMatchObject({
      messages: 0,
      sessions: 0,
      accountTokens: 0,
      providers: {},
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    })
    expect(buildKpiCards(data).find((card) => card.key === 'tokens')?.points).toEqual([100])
  })

  it('preserves the new bucket metrics', async () => {
    const bucket = {
      ...legacy.buckets[0],
      messages: 2,
      sessions: 1,
      accountTokens: 80,
      tokens: { input: 40, output: 10, cacheRead: 50, cacheWrite: 0, reasoning: 0 },
      providers: { openai: 100 },
    }
    vi.mocked(fetchWrapper).mockResolvedValue({ ...legacy, buckets: [bucket] })
    const data = await fetchTokenStats({ ...request, filters: [] })
    expect(data.buckets).toEqual([bucket])
    expect(buildKpiCards(data).find((card) => card.key === 'provider:openai')?.points).toEqual([1])
  })

  it('rejects invalid present metrics instead of hiding them with defaults', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({ ...legacy, buckets: [{ ...legacy.buckets[0], tokens: 'invalid' }] })
    await expect(fetchTokenStats({ ...request, filters: [] })).rejects.toThrow()
  })
})
