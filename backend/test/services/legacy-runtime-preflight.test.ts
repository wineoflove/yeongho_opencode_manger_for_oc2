import { expect, it, vi } from 'vitest'
import { stopLegacyRuntime } from '../../src/services/legacy-runtime-transition'
import { MaintenanceLaunchd } from '../../src/services/claude-maintenance-launchd'

it('reports readiness refusal as verified no-stop failure before touching runtime services', async () => {
  const lifecycle = new MaintenanceLaunchd({
    domain: `gui/${process.getuid?.()}`,
    home: '/synthetic',
    stateDirectory: '/synthetic',
    persist: async () => {},
  })
  const stop = vi.spyOn(lifecycle, 'stop')
  const boot = vi.spyOn(lifecycle, 'boot')
  const unit = {
    pids: [1234],
    registered: true,
    expectedPID: 1234,
    definition: '/synthetic/definition.plist',
    definitionSha256: 'a'.repeat(64),
    stopScope: 'owner' as const,
  }
  try {
    await expect(
      stopLegacyRuntime({
        lifecycle,
        backend: {
          ...unit,
          label: 'io.wineoflove.ocm.backend',
          port: 5101,
          ownedPorts: [5102],
        },
        terminal: { ...unit, label: 'io.wineoflove.ocm.terminal', port: 5104 },
        nativePort: 5102,
        stateDirectory: '/synthetic',
        assertEntryReady: async () => {
          throw new Error('synthetic-work-active')
        },
        assertBackendIdle: async () => {},
        assertOriginalArtifacts: async () => {},
        health: { backend: async () => true, terminal: async () => true },
        persist: async () => {},
      }),
    ).rejects.toMatchObject({
      phase: 'runtime-preflight',
      rollback: 'verified',
    })
    expect(stop).not.toHaveBeenCalled()
    expect(boot).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})
