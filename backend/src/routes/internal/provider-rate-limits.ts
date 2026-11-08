import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { providerRateLimitStore, type ProviderRateLimitStore } from '../../services/provider-rate-limit-store'

const headerName =
  /^(?:retry-after|anthropic-ratelimit-(?:requests|tokens|input-tokens|output-tokens)-(?:limit|remaining|reset)|anthropic-ratelimit-unified-(?:status|representative-claim|(?:5h|7d|7d_oi)-(?:utilization|reset|status)))$/
const observationSchema = z
  .object({
    providerId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
    headers: z.record(
      z.string().regex(headerName),
      z
        .string()
        .max(128)
        .regex(/^[\x20-\x7E]*$/),
    ),
  })
  .strict()

export function createInternalProviderRateLimitRoutes(store: ProviderRateLimitStore = providerRateLimitStore) {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 8192 }))
  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid observation' }, 400)
    }
    const parsed = observationSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid observation' }, 400)
    store.record(parsed.data.providerId, parsed.data.modelId, new Headers(parsed.data.headers))
    return c.json({ accepted: true })
  })
  return app
}
