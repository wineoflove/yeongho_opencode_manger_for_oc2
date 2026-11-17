import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { MaintenanceLaunchd } from '../../src/services/claude-maintenance-launchd'
import { serviceCutoverStep } from '../../src/services/cutover-service-step'
import { captureRuntimeArtifactBaseline } from '../../src/services/runtime-artifact-baseline'

it('rejects changed executable bytes before calling boot while the plist remains unchanged', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-artifact-pin-')))
  try {
    const executable = join(root, 'binary')
    const definition = join(root, 'service.plist')
    await writeFile(executable, 'same-version-original', { mode: 0o700 })
    await writeFile(definition, 'unchanged-definition', { mode: 0o600 })
    const baseline = await captureRuntimeArtifactBaseline([executable])
    const lifecycle = new MaintenanceLaunchd({
      domain: `gui/${process.getuid?.()}`,
      home: root,
      stateDirectory: root,
      persist: async () => {},
    })
    const boot = vi.spyOn(lifecycle, 'boot').mockResolvedValue()
    const step = serviceCutoverStep({
      name: 'service',
      lifecycle,
      unit: {
        label: 'io.wineoflove.ocm.backend',
        port: 5101,
        registered: false,
        pids: [],
      },
      definition,
      sha256: createHash('sha256')
        .update(await readFile(definition))
        .digest('hex'),
      health: async () => true,
      assertBeforeBoot: async () => {
        const actual = await captureRuntimeArtifactBaseline([executable])
        if (actual.files[0]?.sha256 !== baseline.files[0]?.sha256) throw new Error('NATIVE_BINARY_CHANGED')
      },
    })
    await step.forward()
    expect(boot).toHaveBeenCalledOnce()
    boot.mockClear()
    await writeFile(executable, 'same-version-replaced')
    await expect(step.forward()).rejects.toThrow('NATIVE_BINARY_CHANGED')
    expect(boot).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
