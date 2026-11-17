import { describe, expect, it } from 'vitest'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'

function fixture() {
  return {
    version: 2,
    activeAlias: 'first',
    rotationIndex: 7,
    accounts: {
      first: {
        accountId: 'identity-a',
        accessToken: 'synthetic-access-a',
        refreshToken: 'synthetic-refresh-a',
        expiresAt: 1800000000123,
      },
      second: {
        accountId: 'identity-b',
        accessToken: 'synthetic-access-b',
        refreshToken: 'synthetic-refresh-b',
        expiresAt: 1800000000456,
        enabled: false,
        authInvalid: true,
        rateLimitedUntil: 1800000050000,
      },
    },
  }
}

describe('legacy OpenAI credential representation', () => {
  it('preserves credential identity, millisecond expiry and disabled membership without claiming operational transfer', () => {
    const source = fixture()
    const original = JSON.stringify(source)
    const plan = mapLegacyOpenAiCredentials(source)
    expect(
      plan.credentials.map(({ label, activate, value }) => ({
        label,
        activate,
        value,
      })),
    ).toEqual([
      {
        label: 'first',
        activate: false,
        value: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          access: 'synthetic-access-a',
          refresh: 'synthetic-refresh-a',
          expires: 1800000000123,
          metadata: { accountID: 'identity-a' },
        },
      },
      {
        label: 'second',
        activate: false,
        value: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          access: 'synthetic-access-b',
          refresh: 'synthetic-refresh-b',
          expires: 1800000000456,
          metadata: { accountID: 'identity-b' },
        },
      },
    ])
    expect(plan.poolMembership.map((entry) => entry.enabled)).toEqual([true, false])
    expect(plan.activeCredentialID).toBe(plan.credentials[0]?.id)
    expect(plan.legacyRotationIndex).toBe(7)
    expect(plan).toMatchObject({
      executable: false,
      selectionPolicyVerified: false,
      refreshOwnershipTransferred: false,
      sourceArchiveRequired: true,
      targetMustStayStopped: true,
      nativeInactiveCreationGuaranteed: false,
    })
    expect(JSON.stringify(source)).toBe(original)
  })
  it('keeps target IDs stable across label changes and token refresh', () => {
    const before = fixture()
    const after = {
      ...before,
      activeAlias: 'renamed',
      accounts: {
        renamed: {
          ...before.accounts.first,
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
        },
        second: before.accounts.second,
      },
    }
    expect(mapLegacyOpenAiCredentials(after).credentials.map((entry) => entry.id)).toEqual(
      mapLegacyOpenAiCredentials(before).credentials.map((entry) => entry.id),
    )
  })
  it('refuses duplicate identities and unavailable active accounts', () => {
    const source = fixture()
    expect(() =>
      mapLegacyOpenAiCredentials({
        ...source,
        accounts: {
          ...source.accounts,
          second: { ...source.accounts.second, accountId: 'identity-a' },
        },
      }),
    ).toThrow('DUPLICATE_ACCOUNT')
    expect(() => mapLegacyOpenAiCredentials({ ...source, activeAlias: 'missing' })).toThrow(
      'ACTIVE_ACCOUNT_UNAVAILABLE',
    )
    expect(() => mapLegacyOpenAiCredentials({ ...source, activeAlias: 'second' })).toThrow('ACTIVE_ACCOUNT_UNAVAILABLE')
  })
  it.each([{ accountId: '' }, { refreshToken: '' }, { expiresAt: -1 }])('refuses incomplete credentials', (change) => {
    const source = fixture()
    expect(() =>
      mapLegacyOpenAiCredentials({
        ...source,
        accounts: { first: { ...source.accounts.first, ...change } },
      }),
    ).toThrow('INVALID_SOURCE')
  })
})
