import { describe, expect, it } from 'vitest'
import { prepareOpenAiPoolConfig } from '../../src/services/openai-pool-config'

const pool = {
  strategy: 'round-robin',
  accounts: [
    { credentialID: `cred_oc1_${'a'.repeat(32)}`, enabled: true },
    { credentialID: `cred_oc1_${'b'.repeat(32)}`, enabled: true },
  ],
}

describe('OpenAI native pool config binding', () => {
  it.each([
    '@guard22/opencode-multi-auth-codex@1.4.3',
    {
      package: '@guard22/opencode-multi-auth-codex@1.4.3',
      options: { preserve: true },
    },
  ])('binds the pool and removes only the known legacy refresh registration', (legacy) => {
    const config = {
      model: 'openai/gpt-6-astra',
      plugins: [legacy, 'headroom'],
      providers: {
        openai: { models: { model: {} }, settings: { timeout: 30000 } },
        anthropic: { settings: { baseURL: 'existing' } },
      },
      mcp: { servers: {} },
    }
    const original = JSON.stringify(config)
    const result = prepareOpenAiPoolConfig(config, pool)
    expect(result.config).toEqual({
      ...config,
      plugins: ['headroom'],
      providers: {
        ...config.providers,
        openai: {
          ...config.providers.openai,
          settings: { timeout: 30000, accountPool: pool },
        },
      },
    })
    expect(result.removedLegacyCodexRegistrations).toBe(1)
    expect(JSON.stringify(config)).toBe(original)
    expect(prepareOpenAiPoolConfig(result.config, pool).config).toEqual(result.config)
  })
  it.each(['apiKey', 'accessToken', 'authToken', 'credentialID', 'accountPool'])(
    'refuses conflicting %s instead of silently changing routing',
    (key) => {
      expect(() =>
        prepareOpenAiPoolConfig({ providers: { openai: { settings: { [key]: 'existing' } } } }, pool),
      ).toThrow('CONFLICTING_SETTINGS')
    },
  )
  it.each([
    { ...pool, accounts: [pool.accounts[0], pool.accounts[0]] },
    { ...pool, accounts: [] },
    { ...pool, strategy: 'random' },
    { ...pool, accounts: [{ credentialID: 'arbitrary', enabled: true }] },
    {
      ...pool,
      accounts: [{ credentialID: `cred_oc1_${'a'.repeat(32)}`, enabled: false }],
    },
  ])('rejects unsupported or incomplete pool membership', (invalid) => {
    expect(() => prepareOpenAiPoolConfig({}, invalid)).toThrow('INVALID_POOL')
  })
  it('does not remove unknown plugin versions', () => {
    expect(
      prepareOpenAiPoolConfig({ plugins: ['@guard22/opencode-multi-auth-codex@2.0.0'] }, pool)
        .removedLegacyCodexRegistrations,
    ).toBe(0)
  })
})
