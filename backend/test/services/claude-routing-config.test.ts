import { describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { prepareClaudeRoutingConfig } from '../../src/services/claude-routing-config'

const url = 'http://127.0.0.1:5101/api/claude-inference/v1'
const keyFile = '/private/package/keys/ingress.key'

describe('native Claude gateway routing preparation', () => {
  it('preserves unrelated policy while replacing native authentication and pool settings', () => {
    const source = {
      model: 'openai/gpt-6-astra',
      permissions: [{ action: '*', resource: '*', effect: 'ask' }],
      providers: {
        openai: { settings: { accountPool: { accounts: ['keep'] } } },
        anthropic: {
          models: {
            'claude-opus-5-5': { settings: { maxOutputTokens: 32000 } },
          },
          settings: {
            baseURL: 'https://old.invalid',
            apiKey: 'old',
            accessToken: 'old-access',
            authToken: 'old-auth',
            accountPool: { accounts: ['old'] },
            timeout: 30000,
          },
        },
      },
    }
    const output = prepareClaudeRoutingConfig(JSON.stringify(source), url, keyFile)
    expect(parse(output)).toEqual({
      ...source,
      providers: {
        ...source.providers,
        anthropic: {
          ...source.providers.anthropic,
          settings: {
            timeout: 30000,
            baseURL: url,
            apiKey: `{file:${keyFile}}`,
          },
        },
      },
    })
    expect(prepareClaudeRoutingConfig(output, url, keyFile)).toBe(output)
  })

  it('keeps JSONC comments outside edited fields', () => {
    const result = prepareClaudeRoutingConfig('{\n// user note\n"model":"openai/gpt-6-astra",\n}', url, keyFile)
    expect(result).toContain('// user note')
    expect(parse(result).providers.anthropic.settings.apiKey).toBe(`{file:${keyFile}}`)
  })

  it.each([
    '{"providers":{},"providers":{}}',
    '{',
    '[]',
    '{"provider":{"anthropic":{}}}',
    '{"providers":{"anthropic":{"settings":null}}}',
    '{"providers":{"anthropic":null}}',
  ])('rejects ambiguous or legacy source %s', (text) => {
    expect(() => prepareClaudeRoutingConfig(text, url, keyFile)).toThrow('INVALID_CONFIG')
  })

  it.each([
    { models: { opus: { settings: { baseURL: 'https://other.invalid' } } } },
    { settings: { headers: { Authorization: 'old' } } },
    {
      models: {
        opus: { variants: { custom: { settings: { apiKey: 'old' } } } },
      },
    },
  ])('rejects routing overrides that could bypass the gateway', (anthropic) => {
    expect(() => prepareClaudeRoutingConfig(JSON.stringify({ providers: { anthropic } }), url, keyFile)).toThrow(
      'CONFLICTING_OVERRIDE',
    )
  })

  it.each([
    ['https://example.com/api/claude-inference/v1', keyFile],
    [url + '?key=value', keyFile],
    [url, '/private/{env:KEY}'],
    [url, '/private/../key'],
    [url, 'relative.key'],
  ])('rejects unsafe targets', (target, file) => {
    expect(() => prepareClaudeRoutingConfig('{}', target, file)).toThrow('INVALID_TARGET')
  })
})
