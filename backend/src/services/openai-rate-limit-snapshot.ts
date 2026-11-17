import { z } from 'zod'
import { mapLegacyOpenAiCredentials } from './openai-credential-transfer'

const sourceSchema = z.object({
  accounts: z.record(
    z.string(),
    z.object({
      rateLimitedUntil: z.number().int().nonnegative().safe().optional(),
    }),
  ),
})

export class OpenAiRateLimitSnapshotError extends Error {
  constructor() {
    super('RATE_LIMIT_SNAPSHOT_INVALID')
    this.name = 'OpenAiRateLimitSnapshotError'
  }
}

export function snapshotOpenAiRateLimits(source: unknown, observedAt: number) {
  try {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new OpenAiRateLimitSnapshotError()
    const parsed = sourceSchema.parse(source)
    const mapped = mapLegacyOpenAiCredentials(source)
    const entries = mapped.credentials.flatMap((credential) => {
      const until = parsed.accounts[credential.label]?.rateLimitedUntil
      if (until === undefined || until <= observedAt) return []
      return [
        {
          key: `ocm/account-pool/account/openai/${credential.id}`,
          value: {
            version: 1 as const,
            failure: 'rate-limited' as const,
            observedAt,
            cooldownUntil: until,
          },
        },
      ]
    })
    return {
      entries,
      observedAt,
      fullSelectionStateMapped: false,
      executable: false,
    }
  } catch {
    throw new OpenAiRateLimitSnapshotError()
  }
}
