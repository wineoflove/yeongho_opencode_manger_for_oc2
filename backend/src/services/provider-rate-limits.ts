import { z } from 'zod'

const resources = ['requests', 'tokens', 'input-tokens', 'output-tokens'] as const
const UNIFIED_PREFIX = 'anthropic-ratelimit-unified'
const subscriptionWindows = [
  { window: 'five_hour', header: '5h' },
  { window: 'seven_day', header: '7d' },
  { window: 'seven_day_overage_included', header: '7d_oi' },
] as const
export const ANTHROPIC_RATE_LIMIT_HEADERS = [
  'retry-after',
  ...resources.flatMap((resource) =>
    ['limit', 'remaining', 'reset'].map((field) => `anthropic-ratelimit-${resource}-${field}`),
  ),
  `${UNIFIED_PREFIX}-status`,
  `${UNIFIED_PREFIX}-representative-claim`,
  ...subscriptionWindows.flatMap(({ header }) =>
    ['utilization', 'reset', 'status'].map((field) => `${UNIFIED_PREFIX}-${header}-${field}`),
  ),
]
const statusToken = /^[a-z][a-z0-9_]{0,39}$/
const MAX_DATE_MS = 8_640_000_000_000_000
const timestamp = z.string().datetime({ offset: true })
const observedAtSchema = z.number().int().nonnegative().safe()

export interface RateLimitBucket {
  readonly resource: (typeof resources)[number]
  readonly limit: number | null
  readonly remaining: number | null
  readonly resetAt: number | null
  readonly remainingRounded: boolean
}

/**
 * One subscription usage window from Anthropic's unified rate-limit headers, which subscription
 * (OAuth) requests carry instead of the per-resource API key headers. Utilization arrives as a
 * fraction and reset as Unix seconds; both are kept null when absent or malformed.
 */
export interface SubscriptionWindow {
  readonly window: (typeof subscriptionWindows)[number]['window']
  readonly usedPercent: number | null
  readonly resetAt: number | null
  readonly status: string | null
}

export function parseAnthropicRateLimits(headers: Pick<Headers, 'get'>, observedAt: number) {
  observedAtSchema.parse(observedAt)
  const invalidHeaders: string[] = []
  const integer = (name: string): number | null => {
    const raw = headers.get(name)
    if (raw === null) return null
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
    if (Number.isSafeInteger(value) && value >= 0) return value
    invalidHeaders.push(name)
    return null
  }
  const buckets: RateLimitBucket[] = []
  for (const resource of resources) {
    const prefix = `anthropic-ratelimit-${resource}`
    const limit = integer(`${prefix}-limit`)
    const remaining = integer(`${prefix}-remaining`)
    const reset = headers.get(`${prefix}-reset`)
    let resetAt: number | null = null
    if (reset !== null) {
      const parsed = timestamp.safeParse(reset)
      if (parsed.success && Number.isFinite(Date.parse(parsed.data))) resetAt = Date.parse(parsed.data)
      else invalidHeaders.push(`${prefix}-reset`)
    }
    if (limit !== null || remaining !== null || resetAt !== null) {
      buckets.push({
        resource,
        limit,
        remaining,
        resetAt,
        remainingRounded: resource !== 'requests',
      })
    }
  }
  const token = (name: string): string | null => {
    const raw = headers.get(name)
    if (raw === null) return null
    if (statusToken.test(raw.trim())) return raw.trim()
    invalidHeaders.push(name)
    return null
  }
  const windows: SubscriptionWindow[] = []
  for (const { window, header } of subscriptionWindows) {
    const prefix = `${UNIFIED_PREFIX}-${header}`
    const rawUtilization = headers.get(`${prefix}-utilization`)
    let usedPercent: number | null = null
    if (rawUtilization !== null) {
      const value = /^\d+(?:\.\d+)?$/.test(rawUtilization.trim()) ? Number(rawUtilization.trim()) : NaN
      if (Number.isFinite(value)) usedPercent = Math.min(100, Math.round(value * 100))
      else invalidHeaders.push(`${prefix}-utilization`)
    }
    const reset = integer(`${prefix}-reset`)
    let resetAt: number | null = null
    if (reset !== null) {
      const milliseconds = reset * 1000
      if (Number.isSafeInteger(milliseconds) && milliseconds <= MAX_DATE_MS) resetAt = milliseconds
      else invalidHeaders.push(`${prefix}-reset`)
    }
    const status = token(`${prefix}-status`)
    if (usedPercent !== null || resetAt !== null || status !== null) {
      windows.push({ window, usedPercent, resetAt, status })
    }
  }
  const subscriptionStatus = token(`${UNIFIED_PREFIX}-status`)
  const representativeClaim = token(`${UNIFIED_PREFIX}-representative-claim`)
  const retryAfterSeconds = integer('retry-after')
  return {
    source: 'anthropic-http-headers' as const,
    accountId: null,
    observedAt,
    status: invalidHeaders.length
      ? ('partial' as const)
      : buckets.length ||
          windows.length ||
          subscriptionStatus !== null ||
          representativeClaim !== null ||
          retryAfterSeconds !== null
        ? ('observed' as const)
        : ('unobserved' as const),
    buckets,
    subscriptionWindows: windows,
    subscriptionStatus,
    representativeClaim,
    retryAfterSeconds,
    invalidHeaders,
  }
}
