import { chmod, link, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertRuntimeArtifactsUnchanged,
  captureRuntimeArtifactBaseline,
} from '../../src/services/runtime-artifact-baseline'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-artifacts-')))
  roots.push(root)
  const path = join(root, 'artifact')
  await writeFile(path, 'synthetic-secret-content', { mode: 0o600 })
  return { root, path }
}
describe('runtime disk artifact baseline', () => {
  it('pins an explicitly listed executable link count without allowing linked data files', async () => {
    const { root, path } = await fixture()
    await link(path, join(root, 'peer'))
    await expect(
      captureRuntimeArtifactBaseline([path], {
        permittedExecutableHardlinks: [path],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await chmod(path, 0o700)
    const baseline = await captureRuntimeArtifactBaseline([path], {
      permittedExecutableHardlinks: [path],
    })
    await expect(assertRuntimeArtifactsUnchanged(baseline)).resolves.toBeUndefined()
    await link(path, join(root, 'extra-peer'))
    await expect(assertRuntimeArtifactsUnchanged(baseline)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
  })
  it('requires explicit config scope for existing group write and preserves its exact mode', async () => {
    const { root } = await fixture()
    const path = join(root, 'opencode.json')
    await writeFile(path, '{}')
    await chmod(path, 0o664)
    await expect(captureRuntimeArtifactBaseline([path])).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT',
    })
    const baseline = await captureRuntimeArtifactBaseline([path], {
      permittedGroupWritableConfigs: [path],
    })
    expect(baseline.files[0]?.mode).toBe(0o664)
    await expect(assertRuntimeArtifactsUnchanged(baseline)).resolves.toBeUndefined()
    await chmod(path, 0o666)
    await expect(assertRuntimeArtifactsUnchanged(baseline)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
  })
  it('does not extend the config exception to other files or redirected config references', async () => {
    const { root, path } = await fixture()
    await expect(
      captureRuntimeArtifactBaseline([path], {
        permittedGroupWritableConfigs: [path],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    const reference = join(root, 'opencode.json')
    await symlink(path, reference)
    await expect(
      captureRuntimeArtifactBaseline([reference], {
        permittedGroupWritableConfigs: [reference],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
  })
  it('records only a fingerprint and accepts unchanged bytes restored by atomic replacement', async () => {
    const { root, path } = await fixture()
    const baseline = await captureRuntimeArtifactBaseline([path])
    expect(JSON.stringify(baseline)).not.toContain('synthetic-secret-content')
    expect(baseline.runningBytesVerified).toBe(false)
    const replacement = join(root, 'replacement')
    await writeFile(replacement, await readFile(path), { mode: 0o600 })
    await rename(replacement, path)
    await expect(assertRuntimeArtifactsUnchanged(baseline)).resolves.toBeUndefined()
  })
  it('rejects changed bytes even at the same path', async () => {
    const { path } = await fixture()
    const baseline = await captureRuntimeArtifactBaseline([path])
    await writeFile(path, 'changed')
    await expect(assertRuntimeArtifactsUnchanged(baseline)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' })
  })
  it('rejects a redirected reference even if the bytes match', async () => {
    const { root, path } = await fixture()
    const other = join(root, 'other')
    await writeFile(other, await readFile(path), { mode: 0o600 })
    const reference = join(root, 'ref')
    await symlink(path, reference)
    const baseline = await captureRuntimeArtifactBaseline([reference])
    await rm(reference)
    await symlink(other, reference)
    await expect(assertRuntimeArtifactsUnchanged(baseline)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' })
  })
  it.each(['writable', 'hardlink'] as const)('rejects %s artifacts', async (kind) => {
    const { root, path } = await fixture()
    if (kind === 'writable') await chmod(path, 0o666)
    else await link(path, join(root, 'second-link'))
    await expect(captureRuntimeArtifactBaseline([path])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
  })
  it('rejects empty or duplicated inventory', async () => {
    const { path } = await fixture()
    await expect(captureRuntimeArtifactBaseline([])).rejects.toMatchObject({
      code: 'BASELINE_INVALID',
    })
    await expect(captureRuntimeArtifactBaseline([path, path])).rejects.toMatchObject({ code: 'BASELINE_INVALID' })
  })
})
