import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWrapper } from './fetchWrapper'
import { getProviderRateLimits } from './provider-rate-limits'
import { API_BASE_URL } from '@/config'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))

describe('provider rate-limit observation contract', () => {
  beforeEach(() => vi.resetAllMocks())
  const observation = {
    providerId: 'provider',
    modelId: 'model',
    source: 'anthropic-http-headers',
    accountId: null,
    observedAt: 1000,
    stale: true,
    status: 'partial',
    retryAfterSeconds: null,
    invalidHeaders: ['retry-after'],
    buckets: [
      {
        resource: 'requests',
        limit: 50,
        remaining: 0,
        resetAt: null,
        remainingRounded: false,
      },
    ],
    subscriptionWindows: [{ window: 'five_hour', usedPercent: 42, resetAt: 1_800_000_000_000, status: 'allowed' }],
    subscriptionStatus: 'allowed',
    representativeClaim: 'five_hour',
  }
  it('preserves stale partial observations without turning unknown fields into zero', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      persistence: 'memory',
      observations: [{ ...observation, secret: 'private' }],
    })
    expect(await getProviderRateLimits('provider/name')).toEqual({
      persistence: 'memory',
      observations: [observation],
    })
    expect(fetchWrapper).toHaveBeenCalledExactlyOnceWith(`${API_BASE_URL}/api/providers/provider%2Fname/rate-limits`)
  })
  it('keeps transport failures distinct from no observations', async () => {
    vi.mocked(fetchWrapper).mockRejectedValue(new Error('Observation service unavailable'))
    await expect(getProviderRateLimits('provider')).rejects.toThrow('Observation service unavailable')
  })
  it('rejects unsupported account attribution instead of presenting provider limits as account quota', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      persistence: 'memory',
      observations: [{ ...observation, accountId: 'guessed-account' }],
    })
    await expect(getProviderRateLimits('provider')).rejects.toThrow()
  })
})
