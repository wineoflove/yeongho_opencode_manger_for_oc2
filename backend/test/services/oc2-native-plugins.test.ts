import { describe, expect, it } from 'vitest'
import { selectOc2NativePlugins } from '../../src/services/oc2-native-plugins'

describe('approved OC2 native feature selection', () => {
  it.each(['oh-my-openagent@5.1.60', { package: 'oh-my-openagent@5.1.60', options: { keep: true } }])(
    'removes the approved OMO registration while preserving other policy',
    (omo) => {
      const input = {
        plugins: ['headroom', omo, { package: 'other', options: { enabled: false } }],
        model: 'openai/gpt-6.1-sol',
        agents: { assistant: { description: 'preserve', permissions: [] } },
        default_agent: 'assistant',
        providers: {
          openai: { settings: { accountPool: { strategy: 'round-robin' } } },
        },
        mcp: { servers: { existing: { enabled: true } } },
      }
      const before = JSON.stringify(input)
      expect(selectOc2NativePlugins(input)).toEqual({
        config: {
          ...input,
          plugins: ['headroom', { package: 'other', options: { enabled: false } }],
        },
        removed: ['oh-my-openagent@5.1.60'],
      })
      expect(JSON.stringify(input)).toBe(before)
    },
  )
  it('does not infer approval for renamed packages, different versions or local plugin files', () => {
    const input = {
      plugins: [
        'oh-my-openagent@5.1.64',
        'oh-my-openagent',
        '/local/oh-my-openagent.js',
        'other-oh-my-openagent@5.1.60',
      ],
    }
    expect(selectOc2NativePlugins(input)).toEqual({
      config: input,
      removed: [],
    })
  })
  it('preserves absent plugin configuration without adding defaults', () => {
    expect(selectOc2NativePlugins({ default_agent: 'assistant' })).toEqual({
      config: { default_agent: 'assistant' },
      removed: [],
    })
  })
  it.each([
    { plugin: ['legacy'] },
    { plugins: [['legacy-tuple', {}]] },
    { plugins: [{ package: 'other', command: 'unexpected' }] },
    { plugins: null },
  ])('rejects unnormalized or invalid registration shapes', (input) => {
    expect(() => selectOc2NativePlugins(input)).toThrow('INVALID_NATIVE_PLUGIN_CONFIG')
  })
})
