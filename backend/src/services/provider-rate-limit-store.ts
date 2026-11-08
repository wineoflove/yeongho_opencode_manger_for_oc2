import { parseAnthropicRateLimits } from './provider-rate-limits'
import { PROVIDER_RATE_LIMIT_STALE_MS } from '@opencode-manager/shared/schemas'

type Observation = ReturnType<typeof parseAnthropicRateLimits> & {
  readonly providerId: string
  readonly modelId: string
}

export class ProviderRateLimitStore {
  private readonly observations = new Map<string, Observation>()

  record(providerId: string, modelId: string, headers: Headers): void {
    const parsed = parseAnthropicRateLimits(headers, Date.now())
    if (parsed.status === 'unobserved') return
    const key = JSON.stringify([providerId, modelId])
    this.observations.delete(key)
    this.observations.set(key, { ...parsed, providerId, modelId })
    if (this.observations.size > 1000) {
      const oldest = this.observations.keys().next().value
      if (oldest !== undefined) this.observations.delete(oldest)
    }
  }

  list(providerId: string) {
    const now = Date.now()
    return [...this.observations.values()]
      .filter((entry) => entry.providerId === providerId)
      .map((entry) => ({
        ...entry,
        stale: now - entry.observedAt > PROVIDER_RATE_LIMIT_STALE_MS,
      }))
  }
}

export const providerRateLimitStore = new ProviderRateLimitStore()
