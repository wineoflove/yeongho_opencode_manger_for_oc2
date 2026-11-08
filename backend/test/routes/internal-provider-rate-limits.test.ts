import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { createInternalTokenMiddleware } from '../../src/auth/internal-token-middleware'
import { createInternalProviderRateLimitRoutes } from '../../src/routes/internal/provider-rate-limits'
import { ProviderRateLimitStore } from '../../src/services/provider-rate-limit-store'

describe('internal header observations', () => {
  let db: Database
  let app: Hono
  let store: ProviderRateLimitStore
  let token: string
  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    token = getOrCreateInternalToken(db)
    store = new ProviderRateLimitStore()
    app = new Hono()
    app.use('*', createInternalTokenMiddleware(db))
    app.route('/', createInternalProviderRateLimitRoutes(store))
  })
  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })
  const input = {
    providerId: 'anthropic',
    modelId: 'fixture',
    headers: { 'anthropic-ratelimit-requests-remaining': '0' },
  }
  function post(body: unknown, authenticated = true) {
    return app.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }
  it('accepts unified subscription headers and rejects other anthropic header names', async () => {
    const accepted = await post({
      ...input,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1800000000',
        'anthropic-ratelimit-unified-status': 'allowed',
      },
    })
    expect(accepted.status).toBe(200)
    expect(store.list('anthropic')[0]?.subscriptionWindows).toEqual([
      { window: 'five_hour', usedPercent: 50, resetAt: 1_800_000_000_000, status: null },
    ])
    expect((await post({ ...input, headers: { 'anthropic-ratelimit-unified-1y-utilization': '0.5' } })).status).toBe(400)
  })

  it('retains a representative-claim-only observation in the store', async () => {
    expect(
      (await post({ ...input, headers: { 'anthropic-ratelimit-unified-representative-claim': 'seven_day' } })).status,
    ).toBe(200)
    expect(store.list('anthropic')).toMatchObject([{ status: 'observed', representativeClaim: 'seven_day' }])
  })

  it('requires the internal bearer token before recording', async () => {
    expect((await post(input, false)).status).toBe(401)
    expect(store.list('anthropic')).toEqual([])
  })
  it('rejects non-allowlisted headers without echoing their values', async () => {
    const response = await post({
      ...input,
      headers: { authorization: 'private-secret' },
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('private-secret')
    expect(store.list('anthropic')).toEqual([])
  })
  it('records rounded observations without claiming account identity and marks them stale', async () => {
    vi.useFakeTimers()
    expect((await post(input)).status).toBe(200)
    expect(store.list('anthropic')).toMatchObject([
      {
        accountId: null,
        stale: false,
        buckets: [{ resource: 'requests', remaining: 0 }],
      },
    ])
    expect(store.list('other')).toEqual([])
    vi.advanceTimersByTime(300_001)
    expect(store.list('anthropic')[0]?.stale).toBe(true)
  })
  it.each(['1\r\nprivate-header: secret', '\u0000secret', '비밀값'])(
    'rejects unsafe header value before Headers construction: %j',
    async (value) => {
      const response = await post({
        ...input,
        headers: { 'anthropic-ratelimit-requests-remaining': value },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid observation' })
      expect(store.list('anthropic')).toEqual([])
    },
  )
  it('does not overwrite a known observation with an unobserved response', async () => {
    await post(input)
    await post({ ...input, headers: {} })
    expect(store.list('anthropic')).toHaveLength(1)
    expect(store.list('anthropic')[0]?.buckets[0]?.remaining).toBe(0)
  })
})
