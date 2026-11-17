import { describe, expect, it } from 'vitest'
import { planOpenAiRotationTransfer } from '../../src/services/openai-rotation-transfer'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'

const timing = { now: 1800000000000, executionBudgetMs: 60000 }
function fixture(rotationIndex = 0) {
  return {
    version: 2,
    activeAlias: 'a',
    rotationIndex,
    settings: { rotationStrategy: 'round-robin' },
    accounts: {
      a: {
        accountId: 'a',
        accessToken: 'synthetic-a',
        refreshToken: 'synthetic-refresh-a',
        expiresAt: timing.now + 7200000,
        planType: 'pro',
        usageCount: 5,
      },
      b: {
        accountId: 'b',
        accessToken: 'synthetic-b',
        refreshToken: 'synthetic-refresh-b',
        expiresAt: timing.now + 7200000,
        planType: 'pro',
        usageCount: 9,
      },
    },
  }
}

describe('legacy round-robin cursor translation', () => {
  it('preserves a future cooldown only with explicit mode and points selection at the eligible account', () => {
    const source = fixture(7)
    const until = timing.now + 3600000
    const limited = {
      ...source,
      accounts: {
        ...source.accounts,
        a: { ...source.accounts.a, rateLimitedUntil: until },
      },
    }
    const ids = mapLegacyOpenAiCredentials(limited).credentials.map((entry) => entry.id)
    expect(() => planOpenAiRotationTransfer(limited, timing)).toThrow('UNSUPPORTED_SELECTION_STATE')
    const result = planOpenAiRotationTransfer(limited, {
      ...timing,
      preserveRateLimits: true,
    })
    expect(result.nextCredentialID).toBe(ids[1])
    expect(result.cursor.value.credentialID).toBe(ids[0])
    expect(result.accountStates).toEqual([
      {
        key: `ocm/account-pool/account/openai/${ids[0]}`,
        value: {
          version: 1,
          failure: 'rate-limited',
          observedAt: timing.now,
          cooldownUntil: until,
        },
      },
    ])
    expect(result.validUntil).toBe(until - 300000)
  })
  it.each([timing.now + 1, timing.now + timing.executionBudgetMs + 300000])(
    'refuses cooldown expiry within the protected migration window',
    (until) => {
      const source = fixture()
      expect(() =>
        planOpenAiRotationTransfer(
          {
            ...source,
            accounts: {
              ...source.accounts,
              a: { ...source.accounts.a, rateLimitedUntil: until },
            },
          },
          { ...timing, preserveRateLimits: true },
        ),
      ).toThrow('INSUFFICIENT_STABLE_WINDOW')
    },
  )
  it('keeps the legacy cursor and preserves every cooldown when all accounts are cooled down', () => {
    const source = fixture(7)
    const ids = mapLegacyOpenAiCredentials(source).credentials.map((entry) => entry.id)
    const accounts = {
      a: { ...source.accounts.a, rateLimitedUntil: timing.now + 7200000 },
      b: { ...source.accounts.b, rateLimitedUntil: timing.now + 3600000 },
    }
    expect(() => planOpenAiRotationTransfer({ ...source, accounts }, timing)).toThrow('UNSUPPORTED_SELECTION_STATE')
    const plan = planOpenAiRotationTransfer({ ...source, accounts }, { ...timing, preserveRateLimits: true })
    expect(plan.nextCredentialID).toBe(ids[1])
    expect(plan.cursor.value.credentialID).toBe(ids[0])
    expect(plan.accountStates?.map((entry) => entry.value.cooldownUntil).sort()).toEqual(
      [timing.now + 3600000, timing.now + 7200000].sort(),
    )
  })
  it.each([0, 1, 7])('keeps next selection for cursor %s without claiming runtime activation', (index) => {
    const source = fixture(index)
    const ids = mapLegacyOpenAiCredentials(source).credentials.map((entry) => entry.id)
    const plan = planOpenAiRotationTransfer(source, timing)
    expect(plan.nextCredentialID).toBe(ids[index % 2])
    expect(plan.cursor.value.credentialID).toBe(ids[(index + 1) % 2])
    expect(plan.pool.accounts.map((entry) => entry.credentialID)).toEqual(ids)
    expect(plan).toMatchObject({
      executable: false,
      runtimeSelectionVerified: false,
      refreshOwnershipTransferred: false,
    })
  })
  it.each([
    { enabled: false },
    { authInvalid: true },
    { planType: 'plus' },
    { usageCount: 0 },
    { rateLimitedUntil: timing.now - 1 },
    { modelUnsupportedUntil: timing.now + 1000 },
    { workspaceDeactivatedUntil: timing.now + 1000 },
    { lastLimitErrorAt: timing.now - 1000 },
  ])('refuses selection state outside the supported equivalence scope', (change) => {
    const source = fixture()
    expect(() =>
      planOpenAiRotationTransfer(
        {
          ...source,
          accounts: {
            ...source.accounts,
            a: { ...source.accounts.a, ...change },
          },
        },
        timing,
      ),
    ).toThrow('UNSUPPORTED_SELECTION_STATE')
  })
  it('refuses forced or non-round-robin selection', () => {
    expect(() => planOpenAiRotationTransfer({ ...fixture(), forcedAlias: 'a' }, timing)).toThrow(
      'UNSUPPORTED_SELECTION_STATE',
    )
    expect(() =>
      planOpenAiRotationTransfer(
        {
          ...fixture(),
          settings: { rotationStrategy: 'weighted-round-robin' },
        },
        timing,
      ),
    ).toThrow('UNSUPPORTED_SELECTION_STATE')
  })
  it('refuses an unused pool whose priorities change after the first selection', () => {
    const source = fixture()
    expect(() =>
      planOpenAiRotationTransfer(
        {
          ...source,
          accounts: {
            a: { ...source.accounts.a, usageCount: 0 },
            b: { ...source.accounts.b, usageCount: 0 },
          },
        },
        timing,
      ),
    ).toThrow('UNSUPPORTED_SELECTION_STATE')
  })
  it('requires token lifetime for execution plus the native refresh buffer', () => {
    const source = fixture()
    expect(() =>
      planOpenAiRotationTransfer(
        {
          ...source,
          accounts: {
            ...source.accounts,
            a: {
              ...source.accounts.a,
              expiresAt: timing.now + timing.executionBudgetMs + 300000,
            },
          },
        },
        timing,
      ),
    ).toThrow('INSUFFICIENT_TOKEN_LIFETIME')
  })
})
