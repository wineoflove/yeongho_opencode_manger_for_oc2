import { z } from 'zod'

export const PROVIDER_RATE_LIMIT_STALE_MS = 300_000

const count = z.number().int().nonnegative().safe().nullable()
export const ProviderRateLimitObservationSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  source: z.literal('anthropic-http-headers'),
  accountId: z.null(),
  observedAt: z.number().int().nonnegative().safe(),
  stale: z.boolean(),
  status: z.enum(['observed', 'partial', 'unobserved']),
  retryAfterSeconds: count,
  invalidHeaders: z.array(z.string()),
  buckets: z.array(
    z.object({
      resource: z.enum(['requests', 'tokens', 'input-tokens', 'output-tokens']),
      limit: count,
      remaining: count,
      resetAt: count,
      remainingRounded: z.boolean(),
    }),
  ),
  subscriptionWindows: z.array(
    z.object({
      window: z.enum(['five_hour', 'seven_day', 'seven_day_overage_included']),
      usedPercent: z.number().int().min(0).max(100).nullable(),
      resetAt: count,
      status: z.string().nullable(),
    }),
  ),
  subscriptionStatus: z.string().nullable(),
  representativeClaim: z.string().nullable(),
})

export const ProviderRateLimitsResponseSchema = z.object({
  persistence: z.literal('memory'),
  observations: z.array(ProviderRateLimitObservationSchema),
})
export type ProviderRateLimitObservation = z.infer<typeof ProviderRateLimitObservationSchema>
