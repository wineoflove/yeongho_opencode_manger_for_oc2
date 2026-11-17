import { describe, expect, it } from 'vitest'
import { snapshotOpenAiRateLimits } from '../../src/services/openai-rate-limit-snapshot'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'

function source(until: number) {
  const account = (id: string) => ({
    accountId: id,
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: 2000000,
  })
  return {
    version: 2,
    activeAlias: 'first',
    rotationIndex: 0,
    accounts: {
      first: { ...account('first'), rateLimitedUntil: until },
      second: account('second'),
    },
  }
}
describe('stored OpenAI rate-limit snapshot', () => {
  it('retains the exact restriction end without tokens or an activation claim', () => {
    const input = source(100000)
    const original = JSON.stringify(input)
    const id = mapLegacyOpenAiCredentials(input).credentials[0]?.id
    expect(snapshotOpenAiRateLimits(input, 50000)).toEqual({
      entries: [
        {
          key: `ocm/account-pool/account/openai/${id}`,
          value: {
            version: 1,
            failure: 'rate-limited',
            observedAt: 50000,
            cooldownUntil: 100000,
          },
        },
      ],
      observedAt: 50000,
      fullSelectionStateMapped: false,
      executable: false,
    })
    expect(JSON.stringify(input)).toBe(original)
  })
  it.each([49999, 50000])('does not manufacture a future restriction from expired time %s', (until) => {
    expect(snapshotOpenAiRateLimits(source(until), 50000).entries).toEqual([])
  })
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects invalid restriction time %s', (until) => {
    expect(() => snapshotOpenAiRateLimits(source(until), 50000)).toThrow('RATE_LIMIT_SNAPSHOT_INVALID')
  })
})
