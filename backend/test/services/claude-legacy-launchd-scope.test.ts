import { describe, expect, it } from 'vitest'
import { MaintenanceLaunchd } from '../../src/services/claude-maintenance-launchd'
import { MaintenanceLaunchdScope } from '../../src/services/maintenance-launchd-scope'

const context = {
  domain: `gui/${process.getuid?.()}`,
  home: '/private/fixture',
  stateDirectory: '/private/fixture/state',
  persist: async () => {},
}
const expected = {
  definition: '/private/not-read.plist',
  sha256: '0'.repeat(64),
  pid: 12345,
}

describe('explicit legacy runtime launchd scope', () => {
  it('only admits the exact proxy service and port with an explicit opt-in', () => {
    const target = { label: 'com.aion.ocm.claude-proxy', port: 5117 }
    expect(() => new MaintenanceLaunchdScope(context).target(target)).toThrow('INVALID_SCOPE')
    const options = { ...context, claudeProxy: true }
    const scope = new MaintenanceLaunchdScope(options)
    options.claudeProxy = false
    expect(scope.target(target)).toBe(`gui/${process.getuid?.()}/com.aion.ocm.claude-proxy`)
    for (const port of [5003, 5551, 5118]) expect(() => scope.target({ ...target, port })).toThrow('INVALID_SCOPE')
    expect(() => scope.target({ ...target, label: 'unrelated.service' })).toThrow('INVALID_SCOPE')
  })

  it('keeps the proxy scope during recovery without admitting other ports', async () => {
    const scoped = new MaintenanceLaunchd({ ...context, claudeProxy: true })
    await expect(
      scoped.recovery().observeExisting({ label: 'com.aion.ocm.claude-proxy', port: 5118 }, expected),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await expect(
      scoped.recovery().observeExisting({ label: 'com.aion.ocm.claude-proxy', port: 5117 }, expected),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not widen scope if the caller mutates its original target list', async () => {
    const target = { label: 'io.wineoflove.ocm.backend', port: 5101 }
    const targets = [target]
    const scoped = new MaintenanceLaunchd({
      ...context,
      legacyRuntimeTargets: targets,
    })
    target.label = 'unrelated.service'
    await expect(scoped.observeExisting({ label: 'unrelated.service', port: 5101 }, expected)).rejects.toMatchObject({
      code: 'INVALID_SCOPE',
    })
    await expect(
      scoped.recovery().observeExisting({ label: 'unrelated.service', port: 5101 }, expected),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
  })
  it.each([
    { label: 'io.wineoflove.ocm.backend', port: 5101 },
    { label: 'io.wineoflove.ocm.terminal', port: 5104 },
  ])('rejects legacy target without explicit scope before definition access', async (target) => {
    await expect(new MaintenanceLaunchd(context).observeExisting(target, expected)).rejects.toMatchObject({
      code: 'INVALID_SCOPE',
    })
  })
  it.each(
    [
      [{ label: 'io.wineoflove.ocm.backend', port: 5003 }],
      [{ label: 'io.wineoflove.ocm.terminal', port: 5101 }],
      [{ label: 'unrelated.service', port: 5104 }],
      [
        { label: 'io.wineoflove.ocm.backend', port: 5101 },
        { label: 'io.wineoflove.ocm.backend', port: 5101 },
      ],
    ].map((legacyRuntimeTargets) => ({ legacyRuntimeTargets })),
  )('rejects an invalid or duplicate scope', ({ legacyRuntimeTargets }) => {
    expect(() => new MaintenanceLaunchd({ ...context, legacyRuntimeTargets })).toThrow('INVALID_SCOPE')
  })
  it('does not extend explicit backend scope to another service or port', async () => {
    const scoped = new MaintenanceLaunchd({
      ...context,
      legacyRuntimeTargets: [{ label: 'io.wineoflove.ocm.backend', port: 5101 }],
    })
    await expect(
      scoped.observeExisting({ label: 'io.wineoflove.ocm.terminal', port: 5104 }, expected),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await expect(
      scoped.recovery().observeExisting({ label: 'io.wineoflove.ocm.backend', port: 5103 }, expected),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
  })
})
