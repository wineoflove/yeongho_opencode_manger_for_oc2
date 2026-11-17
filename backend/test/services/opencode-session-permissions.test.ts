import { describe, expect, it } from 'vitest'
import { planLegacySessionPermissions } from '../../src/services/opencode-session-permissions'

describe('session permission migration planning', () => {
  it('keeps resource patterns, effects and ordering while mapping renamed actions', () => {
    expect(
      planLegacySessionPermissions([
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'bash', pattern: 'dangerous *', action: 'deny' },
        { permission: 'task', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: 'docs/**', action: 'allow' },
        { permission: 'team_create', pattern: '*', action: 'deny' },
      ]),
    ).toEqual({
      conflicts: [],
      rules: [
        { action: '*', resource: '*', effect: 'ask' },
        { action: 'shell', resource: 'dangerous *', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'read', resource: 'docs/**', effect: 'allow' },
        { action: 'team_create', resource: '*', effect: 'deny' },
      ],
    })
  })
  it('flags different write and edit scopes instead of silently merging grants', () => {
    const result = planLegacySessionPermissions([
      { permission: 'write', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: 'docs/**', action: 'allow' },
    ])
    expect(result.conflicts).toEqual(['merged-action-requires-review:edit'])
  })
  it('recognizes identical explicit alias restrictions without changing effects', () => {
    const result = planLegacySessionPermissions([
      { permission: 'write', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'deny' },
    ])
    expect(result.conflicts).toEqual([])
    expect(result.rules.map((rule) => rule.effect)).toEqual(['deny', 'deny'])
  })
  it('flags wildcard actions whose renamed scope cannot be proven', () => {
    expect(planLegacySessionPermissions([{ permission: 'bash*', pattern: '*', action: 'deny' }]).conflicts).toEqual([
      'wildcard-action-requires-review',
    ])
  })
  it('rejects malformed rules rather than replacing them with a default allow', () => {
    expect(() => planLegacySessionPermissions([{ permission: 'read', action: 'allow' }])).toThrow(
      'INVALID_LEGACY_PERMISSIONS',
    )
  })
})
