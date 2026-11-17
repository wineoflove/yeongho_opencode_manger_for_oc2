import { describe, expect, it } from 'vitest'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'
import { prepareOpenAiRollbackCandidate } from '../../src/services/openai-rollback-candidate'

function fixture() {
  const source = {
    version: 2,
    activeAlias: 'first',
    rotationIndex: 3,
    accounts: {
      first: {
        accountId: 'synthetic-id',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 100000,
        rateLimitedUntil: 2000,
        authInvalid: true,
        usageCount: 5,
      },
    },
  }
  const credentials = mapLegacyOpenAiCredentials(source).credentials
  const id = credentials[0]?.id
  if (!id) throw new Error('FIXTURE_INCOMPLETE')
  return { source, credentials, id }
}

describe('native restriction preserving rollback', () => {
  it.each([
    [1000, 2000],
    [3000, 3000],
  ])('does not shorten stored cooldown with native expiry %s', (until, expected) => {
    const { source, credentials, id } = fixture()
    const result = prepareOpenAiRollbackCandidate(source, {
      version: 1,
      credentials,
      health: {
        paused: false,
        accounts: [
          {
            credentialID: id,
            state: {
              version: 1,
              failure: 'rate-limited',
              observedAt: 100,
              cooldownUntil: until,
              authInvalid: false,
            },
          },
        ],
      },
    })
    expect(result.store.accounts.first).toEqual({
      ...source.accounts.first,
      rateLimitedUntil: expected,
    })
    expect(result.nativeHealthIncluded).toBe(true)
  })
  it('carries native authentication invalidity back without changing unrelated policy', () => {
    const { source, credentials, id } = fixture()
    const healthySource = {
      ...source,
      accounts: { first: { ...source.accounts.first, authInvalid: false } },
    }
    const result = prepareOpenAiRollbackCandidate(healthySource, {
      version: 1,
      credentials,
      health: {
        paused: false,
        accounts: [
          {
            credentialID: id,
            state: { version: 1, failure: 'authentication', observedAt: 100 },
          },
        ],
      },
    })
    expect(result.store.accounts.first).toEqual(source.accounts.first)
  })
  it.each([true, false])(
    'blocks pool/access denial rather than restoring an active legacy pool (paused=%s)',
    (paused) => {
      const { source, credentials, id } = fixture()
      const accounts = paused
        ? []
        : [
            {
              credentialID: id,
              state: { version: 1, failure: 'access-denied', observedAt: 100 },
            },
          ]
      expect(() =>
        prepareOpenAiRollbackCandidate(source, {
          version: 1,
          credentials,
          health: { paused, accounts },
        }),
      ).toThrow('NATIVE_POOL_PAUSED')
    },
  )
  it.each(['duplicate', 'unknown'])('rejects %s native health ownership', (kind) => {
    const { source, credentials, id } = fixture()
    const entry = {
      credentialID: kind === 'unknown' ? 'unrelated' : id,
      state: {
        version: 1,
        failure: 'rate-limited',
        observedAt: 100,
        cooldownUntil: 3000,
      },
    }
    expect(() =>
      prepareOpenAiRollbackCandidate(source, {
        version: 1,
        credentials,
        health: {
          paused: false,
          accounts: kind === 'duplicate' ? [entry, entry] : [entry],
        },
      }),
    ).toThrow('NATIVE_CREDENTIALS_INVALID')
  })
})
