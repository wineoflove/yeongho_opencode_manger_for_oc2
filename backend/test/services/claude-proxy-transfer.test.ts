import { describe, expect, it } from 'vitest'
import { planClaudeTransfer, restoreClaudeTransfer } from '../../src/services/claude-proxy-transfer'

const identities = {
  main: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
}
function fixture() {
  return {
    version: 1,
    cursor: 1,
    paused: false,
    blockedRequests: [],
    ownerPreference: 'preserve',
    accounts: ['main', 'second'].map((id) => ({
      id,
      label: `Label ${id}`,
      enabled: true,
      status: 'ok',
      cooldownUntil: 0,
      additionalSetting: 'preserve',
      credentials: {
        type: 'oauth',
        access: `old-access-${id}`,
        refresh: `old-refresh-${id}`,
        expires: 1800000000000,
        extra: 'preserve',
      },
    })),
  }
}

describe('Claude credential ownership transfer data', () => {
  it('restores refreshed credentials while preserving pool settings and account order', () => {
    const pool = fixture()
    const source = JSON.stringify(pool)
    const plan = planClaudeTransfer(source, identities)
    const files = Object.fromEntries(
      plan.files.map((file) => [
        file.name,
        {
          ...file.value,
          access_token: `new-${file.name}`,
          refresh_token: `rotated-${file.name}`,
          expired: '2030-01-01T00:00:00Z',
        },
      ]),
    )
    const restored = JSON.parse(restoreClaudeTransfer(source, plan.ledger, files))
    expect(restored).toEqual({
      ...pool,
      accounts: pool.accounts.map((account) => ({
        ...account,
        credentials: {
          ...account.credentials,
          access: `new-legacy-${account.id}.json`,
          refresh: `rotated-legacy-${account.id}.json`,
          expires: Date.parse('2030-01-01T00:00:00Z'),
        },
      })),
    })
    expect(JSON.stringify(plan.ledger)).not.toContain('old-access')
    expect(JSON.stringify(plan.ledger)).not.toContain('old-refresh')
  })

  it.each(['changed-source', 'missing-account', 'wrong-identity', 'duplicate-ledger', 'disabled-changed'])(
    'rejects unsafe rollback: %s',
    (kind) => {
      const source = JSON.stringify(fixture())
      const plan = planClaudeTransfer(source, identities)
      const files = Object.fromEntries(plan.files.map((file) => [file.name, file.value]))
      let text = source
      switch (kind) {
        case 'changed-source':
          text = source + ' '
          break
        case 'missing-account':
          delete files['legacy-second.json']
          break
        case 'disabled-changed':
          if (files['legacy-main.json']) files['legacy-main.json'].disabled = true
          break
        case 'wrong-identity':
          if (files['legacy-main.json']) files['legacy-main.json'].account_uuid = identities.second
          break
        case 'duplicate-ledger': {
          const entry = plan.ledger.entries[0]
          if (entry) plan.ledger.entries = [entry, entry]
          break
        }
        default:
          throw new Error('unexpected_case')
      }
      expect(() => restoreClaudeTransfer(text, plan.ledger, files)).toThrow(
        kind === 'changed-source' ? 'SOURCE_CHANGED' : 'ACCOUNT_MISMATCH',
      )
    },
  )

  it('rejects duplicate real account identities even when tokens differ', () => {
    expect(() =>
      planClaudeTransfer(JSON.stringify(fixture()), {
        main: identities.main,
        second: identities.main,
      }),
    ).toThrow('ACCOUNT_MISMATCH')
  })

  it('does not reset a source access-denial pause during migration', () => {
    expect(() => planClaudeTransfer(JSON.stringify({ ...fixture(), paused: true }), identities)).toThrow(
      'SOURCE_BLOCKED',
    )
  })
})
