import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MaintenanceLaunchd } from '../../src/services/claude-maintenance-launchd'
import { frontendPromotionCutoverStep } from '../../src/services/release-runtime-cutover-steps'

it.each(['frontend', 'gateway'] as const)(
  'refuses promotion before service actions when pinned maintenance %s changes',
  async (changed) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'promotion-pin-')))
    try {
      const frontendPath = join(root, 'frontend.plist')
      const gatewayPath = join(root, 'gateway.plist')
      const original = 'synthetic-pinned-definition'
      for (const path of [frontendPath, gatewayPath]) await writeFile(path, original, { mode: 0o600 })
      const sha256 = createHash('sha256').update(original).digest('hex')
      const lifecycle = new MaintenanceLaunchd({
        domain: `gui/${process.getuid?.()}`,
        home: root,
        stateDirectory: root,
        persist: async () => {},
      })
      const stop = vi.spyOn(lifecycle, 'stop')
      const boot = vi.spyOn(lifecycle, 'boot')
      const step = frontendPromotionCutoverStep({
        context: {
          lifecycle,
          frontend: {
            label: 'synthetic-frontend',
            port: 5131,
            pids: [],
            registered: true,
          },
          gateway: {
            label: 'synthetic-gateway',
            port: 5132,
            pids: [],
            registered: true,
          },
          definitions: {
            frontend: frontendPath,
            gateway: gatewayPath,
            stateDirectory: root,
          },
          probes: {
            normal: async () => true,
            maintenance: async () => true,
            gateway: async () => true,
          },
          assertReady: async () => {},
          persist: async () => {},
        },
        restore: { source: frontendPath, snapshot: frontendPath, sha256 },
        release: {
          definition: '/synthetic/release.plist',
          sha256,
          probe: async () => true,
        },
        maintenance: {
          frontend: { path: frontendPath, sha256 },
          gateway: { path: gatewayPath, sha256 },
        },
      })
      const path = changed === 'frontend' ? frontendPath : gatewayPath
      await writeFile(path, 'foreign-change')
      await expect(step.forward()).rejects.toBeInstanceOf(Error)
      expect(stop).not.toHaveBeenCalled()
      expect(boot).not.toHaveBeenCalled()
      expect(await readFile(path, 'utf8')).toBe('foreign-change')
    } finally {
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true })
    }
  },
)
