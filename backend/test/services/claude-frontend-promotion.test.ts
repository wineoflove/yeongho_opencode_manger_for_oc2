import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceLaunchd } from '../../src/services/claude-maintenance-launchd'
import { MaintenanceLaunchdError } from '../../src/services/claude-launchd-definition'
import {
  promoteFrontendFromMaintenance,
  restoreFrontendMaintenance,
} from '../../src/services/claude-frontend-transition'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'frontend-promotion-')))
  roots.push(root)
  const frontend = {
    label: 'io.wineoflove.ocm.frontend',
    port: 5173,
    registered: true,
    pids: [],
  }
  const gateway = {
    label: 'com.aion.ocm.maintenance-ingress',
    port: 5141,
    registered: true,
    pids: [],
  }
  const original = join(root, 'original.plist')
  const release = join(root, 'release.plist')
  const definition = (command: string) => JSON.stringify({ Label: frontend.label, ProgramArguments: [command] })
  const originalText = definition('/fixture/original')
  const releaseText = definition('/fixture/release')
  await writeFile(original, originalText, { mode: 0o600 })
  await writeFile(release, releaseText, { mode: 0o600 })
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const lifecycle = new MaintenanceLaunchd({
    domain: `gui/${process.getuid?.()}`,
    home: root,
    stateDirectory: root,
    persist: async () => {},
  })
  let serving = 'maintenance'
  vi.spyOn(lifecycle, 'stop').mockImplementation(async (unit) => {
    unit.registered = false
    if (unit.label === frontend.label) serving = 'down'
  })
  vi.spyOn(lifecycle, 'boot').mockImplementation(async (unit, path, probe) => {
    unit.registered = true
    serving = (await readFile(path, 'utf8')) === originalText ? 'original' : 'release'
    if (!(await probe(AbortSignal.timeout(1000)))) throw new MaintenanceLaunchdError('HEALTH_TIMEOUT')
  })
  vi.spyOn(lifecycle, 'recovery').mockReturnValue(lifecycle)
  return {
    context: {
      lifecycle,
      frontend,
      gateway,
      definitions: {
        frontend: original,
        gateway: original,
        stateDirectory: root,
      },
      probes: {
        normal: async () => serving === 'original',
        maintenance: async () => true,
        gateway: async () => true,
      },
      assertReady: async () => {},
      persist: async () => {},
    },
    restore: {
      source: original,
      snapshot: original,
      sha256: hash(originalText),
    },
    release: {
      definition: release,
      sha256: hash(releaseText),
      probe: async () => serving === 'release',
    },
    serving: () => serving,
  }
}

describe('maintenance frontend promotion', () => {
  it('serves the release and can restore the original using the same restore point', async () => {
    const f = await fixture()
    await promoteFrontendFromMaintenance(f.context, f.restore, f.release)
    expect(f.serving()).toBe('release')
    expect(f.context.gateway.registered).toBe(false)
    await restoreFrontendMaintenance(f.context, f.restore)
    expect(f.serving()).toBe('original')
    expect(f.context.frontend.registered).toBe(true)
  })

  it('keeps the gateway registered when release health fails and delegates rollback to the caller', async () => {
    const f = await fixture()
    await expect(
      promoteFrontendFromMaintenance(f.context, f.restore, {
        ...f.release,
        probe: async () => false,
      }),
    ).rejects.toMatchObject({
      phase: 'release-frontend-start',
      primaryCode: 'HEALTH_TIMEOUT',
    })
    expect(f.context.gateway.registered).toBe(true)
    expect(f.serving()).not.toBe('original')
  })

  it('refuses changed release bytes without interrupting the maintenance frontend', async () => {
    const f = await fixture()
    await writeFile(f.release.definition, 'changed')
    await expect(promoteFrontendFromMaintenance(f.context, f.restore, f.release)).rejects.toMatchObject({
      code: 'IDENTITY_CHANGED',
    })
    expect(f.serving()).toBe('maintenance')
    expect(f.context.gateway.registered).toBe(true)
  })
})
