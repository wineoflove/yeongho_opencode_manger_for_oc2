import { describe, expect, it } from 'vitest'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'
import { prepareOpenAiRollbackCandidate } from '../../src/services/openai-rollback-candidate'

function fixture() {
  const source = {
    version: 2,
    activeAlias: 'first',
    rotationIndex: 7,
    rotationStrategy: 'round-robin',
    futureSetting: { retained: true },
    accounts: {
      first: {
        accountId: 'identity-a',
        accessToken: 'old-access-a',
        refreshToken: 'old-refresh-a',
        expiresAt: 1800000000000,
        usageCount: 23,
      },
      second: {
        accountId: 'identity-b',
        accessToken: 'old-access-b',
        refreshToken: 'old-refresh-b',
        expiresAt: 1800000000000,
        enabled: false,
        authInvalid: true,
        rateLimitedUntil: 1800000090000,
      },
    },
  }
  const entries = mapLegacyOpenAiCredentials(source).credentials.map((entry, index) => ({
    id: entry.id,
    integrationID: entry.integrationID,
    label: `renamed-${index}`,
    active: index === 1,
    value: {
      ...entry.value,
      access: `new-access-${index}`,
      refresh: `new-refresh-${index}`,
      expires: 1800000200000 + index,
    },
  }))
  return { source, entries }
}

describe('OpenAI rollback credential candidate', () => {
  it('returns latest tokens by stable identity without changing legacy policy or either input', () => {
    const { source, entries } = fixture()
    const before = JSON.stringify({ source, entries })
    const candidate = prepareOpenAiRollbackCandidate(source, [...entries].reverse())
    expect(candidate.store).toEqual({
      ...source,
      accounts: {
        first: {
          ...source.accounts.first,
          accessToken: 'new-access-0',
          refreshToken: 'new-refresh-0',
          expiresAt: 1800000200000,
        },
        second: {
          ...source.accounts.second,
          accessToken: 'new-access-1',
          refreshToken: 'new-refresh-1',
          expiresAt: 1800000200001,
        },
      },
    })
    expect(JSON.stringify({ source, entries })).toBe(before)
  })

  it.each(['missing', 'duplicate', 'extra', 'identity', 'id', 'provider', 'method', 'refresh'] as const)(
    'refuses %s credentials rather than restoring stale values',
    (change) => {
      const { source, entries } = fixture()
      const first = entries[0]
      const second = entries[1]
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      if (!first || !second) throw new Error('FIXTURE_INCOMPLETE')
      const variants = {
        missing: [first],
        duplicate: [first, first],
        extra: [...entries, first],
        identity: [
          {
            ...first,
            value: { ...first.value, metadata: { accountID: 'other' } },
          },
          second,
        ],
        id: [{ ...first, id: 'cred_unrelated' }, second],
        provider: [{ ...first, integrationID: 'anthropic' }, second],
        method: [{ ...first, value: { ...first.value, methodID: 'other' } }, second],
        refresh: [{ ...first, value: { ...first.value, refresh: '' } }, second],
      }
      expect(() => prepareOpenAiRollbackCandidate(source, variants[change])).toThrow('NATIVE_CREDENTIALS_INVALID')
    },
  )

  it('rejects invalid legacy source instead of constructing a partial replacement', () => {
    const { source, entries } = fixture()
    expect(() => prepareOpenAiRollbackCandidate({ ...source, activeAlias: 'missing' }, entries)).toThrow(
      'LEGACY_SOURCE_INVALID',
    )
  })
})
