import { describe, expect, it } from 'vitest'
import { prepareOc2InferenceConfig } from '../../src/services/oc2-inference-config'

const pool = {
  strategy: 'round-robin',
  accounts: [{ credentialID: `cred_oc1_${'a'.repeat(32)}`, enabled: true }],
}
const gateway = {
  baseURL: 'http://127.0.0.1:5101/api/claude-inference/v1',
  ingressKeyFile: '/private/package/ingress.key',
}

describe('OC2 combined inference config preparation', () => {
  it('keeps model, tools and user policy while splitting OpenAI native pool from Claude proxy ownership', () => {
    const source = {
      model: { providerID: 'openai', model: 'gpt-6.1-sol', variant: 'high' },
      default_agent: 'assistant',
      agents: {
        assistant: {
          system: 'preserved',
          permissions: [{ action: '*', resource: '*', effect: 'ask' }],
        },
      },
      mcp: { servers: { local: { command: ['not-executed'] } } },
      plugins: ['oh-my-openagent@5.1.60', '@guard22/opencode-multi-auth-codex@1.4.3', 'headroom'],
      providers: {
        openai: {
          models: { 'gpt-6.1-sol': { settings: { reasoningEffort: 'high' } } },
        },
        anthropic: {
          settings: {
            apiKey: 'previous',
            accountPool: { strategy: 'round-robin', accounts: [] },
            timeout: 30000,
          },
        },
      },
    }
    const original = JSON.stringify(source)
    const candidate = prepareOc2InferenceConfig(source, pool, gateway)
    expect(JSON.parse(candidate.text)).toEqual({
      ...source,
      plugins: ['headroom'],
      providers: {
        openai: { ...source.providers.openai, settings: { accountPool: pool } },
        anthropic: {
          settings: {
            baseURL: gateway.baseURL,
            apiKey: `{file:${gateway.ingressKeyFile}}`,
            timeout: 30000,
          },
        },
      },
    })
    expect(candidate.removedOmoRegistrations).toBe(1)
    expect(candidate.removedLegacyCodexRegistrations).toBe(1)
    expect(JSON.stringify(source)).toBe(original)
    expect(JSON.parse(prepareOc2InferenceConfig(JSON.parse(candidate.text), pool, gateway).text)).toEqual(
      JSON.parse(candidate.text),
    )
  })
  it('does not emit a combined candidate when the Claude path conflicts even if OpenAI binding is valid', () => {
    expect(() =>
      prepareOc2InferenceConfig(
        {
          providers: {
            anthropic: { settings: { headers: { Authorization: 'old' } } },
          },
        },
        pool,
        gateway,
      ),
    ).toThrow('CONFLICTING_OVERRIDE')
  })
  it('does not emit a combined candidate when OpenAI credentials conflict', () => {
    expect(() =>
      prepareOc2InferenceConfig({ providers: { openai: { settings: { apiKey: 'old' } } } }, pool, gateway),
    ).toThrow('CONFLICTING_SETTINGS')
  })
})
