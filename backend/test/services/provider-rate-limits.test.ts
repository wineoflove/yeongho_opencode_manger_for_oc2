import { describe, expect, it } from 'vitest'
import { parseAnthropicRateLimits } from '../../src/services/provider-rate-limits'

describe('Anthropic response header observations', () => {
  it('preserves zero remaining, rounded token semantics and an offset reset time', () => {
    const result = parseAnthropicRateLimits(
      new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-input-tokens-remaining': '1000',
        'anthropic-ratelimit-requests-reset': '2026-11-06T10:00:00+09:00',
        'retry-after': '12',
      }),
      100,
    )
    expect(result).toEqual({
      source: 'anthropic-http-headers',
      accountId: null,
      observedAt: 100,
      status: 'observed',
      retryAfterSeconds: 12,
      invalidHeaders: [],
      buckets: [
        {
          resource: 'requests',
          limit: 50,
          remaining: 0,
          resetAt: Date.parse('2026-11-06T01:00:00Z'),
          remainingRounded: false,
        },
        {
          resource: 'input-tokens',
          limit: null,
          remaining: 1000,
          resetAt: null,
          remainingRounded: true,
        },
      ],
      subscriptionWindows: [],
      subscriptionStatus: null,
      representativeClaim: null,
    })
  })

  it('reads subscription utilization windows from unified headers as percentages with Unix-second resets', () => {
    const result = parseAnthropicRateLimits(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '0.4234',
        'anthropic-ratelimit-unified-5h-reset': '1800000000',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '1.2',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
      }),
      100,
    )

    expect(result.status).toBe('observed')
    expect(result.buckets).toEqual([])
    expect(result.subscriptionStatus).toBe('allowed_warning')
    expect(result.representativeClaim).toBe('five_hour')
    expect(result.subscriptionWindows).toEqual([
      { window: 'five_hour', usedPercent: 42, resetAt: 1_800_000_000_000, status: 'allowed' },
      { window: 'seven_day', usedPercent: 100, resetAt: null, status: null },
      { window: 'seven_day_overage_included', usedPercent: null, resetAt: null, status: 'allowed' },
    ])
  })

  it.each(['9007199254741', '8640000000001'])(
    'records an out-of-range subscription reset of %s seconds as invalid instead of a window',
    (reset) => {
      const resetOnly = parseAnthropicRateLimits(new Headers({ 'anthropic-ratelimit-unified-5h-reset': reset }), 100)
      expect(resetOnly.status).toBe('partial')
      expect(resetOnly.subscriptionWindows).toEqual([])
      expect(resetOnly.invalidHeaders).toEqual(['anthropic-ratelimit-unified-5h-reset'])

      const withUsage = parseAnthropicRateLimits(
        new Headers({
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-reset': reset,
        }),
        100,
      )
      expect(withUsage.status).toBe('partial')
      expect(withUsage.subscriptionWindows).toEqual([{ window: 'five_hour', usedPercent: 20, resetAt: null, status: null }])
    },
  )

  it.each([
    ['8640000000000', 8_640_000_000_000_000],
    ['0', 0],
  ])('accepts the boundary subscription reset of %s seconds', (reset, resetAt) => {
    const result = parseAnthropicRateLimits(new Headers({ 'anthropic-ratelimit-unified-5h-reset': reset }), 100)
    expect(result.status).toBe('observed')
    expect(result.invalidHeaders).toEqual([])
    expect(result.subscriptionWindows).toEqual([{ window: 'five_hour', usedPercent: null, resetAt, status: null }])
  })

  it('keeps a representative-claim-only response as an observation', () => {
    const result = parseAnthropicRateLimits(
      new Headers({ 'anthropic-ratelimit-unified-representative-claim': 'five_hour' }),
      100,
    )
    expect(result.status).toBe('observed')
    expect(result.representativeClaim).toBe('five_hour')
    expect(parseAnthropicRateLimits(new Headers(), 100).status).toBe('unobserved')
  })

  it('marks malformed unified headers partial instead of inventing usage', () => {
    const result = parseAnthropicRateLimits(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '-0.5',
        'anthropic-ratelimit-unified-7d-reset': 'tomorrow',
        'anthropic-ratelimit-unified-status': 'Allowed; injected',
      }),
      100,
    )

    expect(result.status).toBe('partial')
    expect(result.subscriptionWindows).toEqual([])
    expect(result.subscriptionStatus).toBeNull()
    expect(result.invalidHeaders).toEqual([
      'anthropic-ratelimit-unified-5h-utilization',
      'anthropic-ratelimit-unified-7d-reset',
      'anthropic-ratelimit-unified-status',
    ])
  })

  it('does not turn absent headers into zero quota or expose unrelated secrets', () => {
    const result = parseAnthropicRateLimits(
      new Headers({
        authorization: 'private-auth',
        'set-cookie': 'private-cookie',
        'x-account-id': 'private-account',
      }),
      100,
    )
    expect(result).toMatchObject({
      status: 'unobserved',
      accountId: null,
      buckets: [],
      retryAfterSeconds: null,
      invalidHeaders: [],
    })
    expect(JSON.stringify(result)).not.toContain('private-')
  })

  it.each(['-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992', ''])(
    'rejects invalid counts without retaining raw value: %s',
    (value) => {
      const result = parseAnthropicRateLimits(
        new Headers({
          'anthropic-ratelimit-requests-remaining': value,
          'anthropic-ratelimit-tokens-limit': '1000',
        }),
        100,
      )
      expect(result).toMatchObject({
        status: 'partial',
        invalidHeaders: ['anthropic-ratelimit-requests-remaining'],
        buckets: [{ resource: 'tokens', limit: 1000 }],
      })
      expect(result.buckets).toHaveLength(1)
    },
  )

  it('rejects invalid reset dates and observation timestamps', () => {
    expect(
      parseAnthropicRateLimits(
        new Headers({
          'anthropic-ratelimit-tokens-reset': '2026-02-30T00:00:00Z',
        }),
        100,
      ),
    ).toMatchObject({
      status: 'partial',
      buckets: [],
      invalidHeaders: ['anthropic-ratelimit-tokens-reset'],
    })
    expect(() => parseAnthropicRateLimits(new Headers(), NaN)).toThrow()
  })
})
