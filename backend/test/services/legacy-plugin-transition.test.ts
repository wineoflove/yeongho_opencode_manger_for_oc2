import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transitionLegacyPlugins } from '../../src/services/legacy-plugin-transition'
import * as files from '../../src/services/claude-database-files'
import * as publication from '../../src/services/claude-transfer-activate'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-plugin-transition-')))
  roots.push(root)
  const sourceDirectory = join(root, 'plugin')
  await mkdir(sourceDirectory, { mode: 0o700 })
  const values = { 'a.js': 'export const a = 1', 'b.js': 'export const b = 2' }
  for (const [name, text] of Object.entries(values)) await writeFile(join(sourceDirectory, name), text, { mode: 0o644 })
  await writeFile(join(sourceDirectory, 'user.js'), 'user-owned')
  const input = {
    sourceDirectory,
    archiveDirectory: join(root, 'archive'),
    entries: Object.entries(values).map(([name, text]) => ({
      name,
      sha256: createHash('sha256').update(text).digest('hex'),
    })),
    assertQuiescent: vi.fn(async () => {}),
  }
  return { input, values }
}
describe('hash-bound legacy plugin archive and restore', () => {
  it('retries safely after an incomplete pending manifest without touching source files', async () => {
    const { input, values } = await fixture()
    const original = publication.durableTransferRecord
    const write = vi.spyOn(publication, 'durableTransferRecord').mockImplementation(async (path, data) => {
      if (path.endsWith('/manifest.json')) {
        await writeFile(path, '{', { mode: 0o600 })
        throw new Error('manifest failed')
      }
      await original(path, data)
    })
    await expect(transitionLegacyPlugins(input, 'archive')).rejects.toMatchObject({ code: 'TRANSITION_FAILED' })
    for (const [name, text] of Object.entries(values))
      expect(await readFile(join(input.sourceDirectory, name), 'utf8')).toBe(text)
    await expect(readdir(input.archiveDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    write.mockRestore()
    expect(await transitionLegacyPlugins(input, 'archive')).toMatchObject({
      changed: 2,
    })
  })
  it('retries file synchronization even when a restore target already exists', async () => {
    const { input } = await fixture()
    await transitionLegacyPlugins(input, 'archive')
    const original = files.syncDatabasePath
    let failures = 0
    const sync = vi.spyOn(files, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path === join(input.sourceDirectory, 'a.js')) {
        failures++
        throw new Error('source sync failed')
      }
      await original(path, directory)
    })
    await expect(transitionLegacyPlugins(input, 'restore')).rejects.toMatchObject({ code: 'TRANSITION_FAILED' })
    await expect(transitionLegacyPlugins(input, 'restore')).rejects.toMatchObject({ code: 'TRANSITION_FAILED' })
    expect(failures).toBe(2)
    sync.mockRestore()
    expect(await transitionLegacyPlugins(input, 'restore')).toMatchObject({
      changed: 1,
    })
  })
  it('accepts a group-writable source directory only with explicit opt-in and never an other-writable one', async () => {
    const { input, values } = await fixture()
    await chmod(input.sourceDirectory, 0o775)
    await expect(transitionLegacyPlugins(input, 'archive')).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    for (const [name, text] of Object.entries(values))
      expect(await readFile(join(input.sourceDirectory, name), 'utf8')).toBe(text)
    const optedIn = { ...input, allowGroupWritableSource: true }
    expect(await transitionLegacyPlugins(optedIn, 'archive')).toMatchObject({ changed: 2 })
    expect(await transitionLegacyPlugins(optedIn, 'restore')).toMatchObject({ changed: 2 })
    await chmod(input.sourceDirectory, 0o777)
    await expect(transitionLegacyPlugins(optedIn, 'archive')).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    for (const [name, text] of Object.entries(values))
      expect(await readFile(join(input.sourceDirectory, name), 'utf8')).toBe(text)
  })
  it('archives only listed originals, supports replay and restores without deleting the archive', async () => {
    const { input, values } = await fixture()
    expect(await transitionLegacyPlugins(input, 'archive')).toMatchObject({
      changed: 2,
    })
    expect(await readdir(input.sourceDirectory)).toEqual(['user.js'])
    expect(await transitionLegacyPlugins(input, 'archive')).toMatchObject({
      changed: 0,
    })
    expect(await transitionLegacyPlugins(input, 'restore')).toMatchObject({
      changed: 2,
    })
    expect(await transitionLegacyPlugins(input, 'restore')).toMatchObject({
      changed: 0,
    })
    for (const [name, text] of Object.entries(values)) {
      expect(await readFile(join(input.sourceDirectory, name), 'utf8')).toBe(text)
      expect(await readFile(join(input.archiveDirectory, `${name}.original`), 'utf8')).toBe(text)
    }
    expect(await readFile(join(input.sourceDirectory, 'user.js'), 'utf8')).toBe('user-owned')
  })
  it('resumes a partial archive after a stop-check failure', async () => {
    const { input } = await fixture()
    input.assertQuiescent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stop check'))
    await expect(transitionLegacyPlugins(input, 'archive')).rejects.toMatchObject({ code: 'TRANSITION_FAILED' })
    expect(await readdir(input.sourceDirectory)).toEqual(['b.js', 'user.js'])
    expect(await transitionLegacyPlugins(input, 'archive')).toMatchObject({
      changed: 1,
    })
    expect(await transitionLegacyPlugins(input, 'restore')).toMatchObject({
      changed: 2,
    })
  })
  it('preserves the source if archive content changes before source removal', async () => {
    const { input, values } = await fixture()
    input.assertQuiescent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await writeFile(join(input.archiveDirectory, 'a.js.original'), 'changed')
      })
    await expect(transitionLegacyPlugins(input, 'archive')).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    expect(await readFile(join(input.sourceDirectory, 'a.js'), 'utf8')).toBe(values['a.js'])
  })
  it('does not overwrite a changed plugin during restoration', async () => {
    const { input } = await fixture()
    await transitionLegacyPlugins(input, 'archive')
    await writeFile(join(input.sourceDirectory, 'a.js'), 'new-user-change')
    await expect(transitionLegacyPlugins(input, 'restore')).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    expect(await readFile(join(input.sourceDirectory, 'a.js'), 'utf8')).toBe('new-user-change')
  })
  it.each(['child', 'parent', 'sibling-prefix'])('rejects unsafe archive nesting %s', async (kind) => {
    const { input } = await fixture()
    const archiveDirectory =
      kind === 'child'
        ? join(input.sourceDirectory, 'archive')
        : kind === 'parent'
          ? join(input.sourceDirectory, '..')
          : join(input.sourceDirectory, '..archive')
    await expect(transitionLegacyPlugins({ ...input, archiveDirectory }, 'archive')).rejects.toMatchObject({
      code: 'INVALID_SCOPE',
    })
  })
  it('rejects a different manifest plan on resume', async () => {
    const { input } = await fixture()
    await transitionLegacyPlugins(input, 'archive')
    await expect(
      transitionLegacyPlugins({ ...input, entries: input.entries.slice(0, 1) }, 'restore'),
    ).rejects.toMatchObject({ code: 'JOURNAL_MISMATCH' })
  })
})
