import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishPluginCopy, recoverPluginCopy } from '../../src/services/legacy-plugin-files'
import * as files from '../../src/services/claude-database-files'
import * as io from 'node:fs/promises'
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: vi.fn(actual.copyFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-copy-')))
  roots.push(root)
  await mkdir(join(root, 'archive'), { mode: 0o700 })
  await mkdir(join(root, 'loader'), { mode: 0o700 })
  const source = join(root, 'original.js')
  const text = 'synthetic complete plugin'
  await writeFile(source, text, { mode: 0o600 })
  return {
    text,
    input: {
      source,
      target: join(root, 'loader/plugin.js'),
      directory: join(root, 'archive'),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  }
}
describe('complete plugin copy publication', () => {
  it('leaves no partial loader file when copying the pending file fails', async () => {
    const { input, text } = await fixture()
    vi.mocked(io.copyFile).mockImplementationOnce(async (source, target) => {
      const data = await readFile(source)
      await writeFile(target, data.subarray(0, 4), {
        mode: 0o600,
        flag: 'wx',
      })
      throw new Error('partial copy')
    })
    await expect(publishPluginCopy(input)).rejects.toThrow('partial copy')
    await expect(readFile(input.target)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(input.source, 'utf8')).toBe(text)
    await publishPluginCopy(input)
    expect(await readFile(input.target, 'utf8')).toBe(text)
  })
  it('does not overwrite an existing final file', async () => {
    const { input, text } = await fixture()
    await writeFile(input.target, 'user-content')
    await expect(publishPluginCopy(input)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await readFile(input.target, 'utf8')).toBe('user-content')
    expect(await readFile(input.source, 'utf8')).toBe(text)
  })
  it('does not publish before pending-file synchronization succeeds and can retry', async () => {
    const { input, text } = await fixture()
    const original = files.syncDatabasePath
    const sync = vi.spyOn(files, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path.includes('.plugin-pending-')) throw new Error('pending sync failed')
      await original(path, directory)
    })
    await expect(publishPluginCopy(input)).rejects.toThrow('pending sync failed')
    await expect(readFile(input.target)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    sync.mockRestore()
    await publishPluginCopy(input)
    expect(await readFile(input.target, 'utf8')).toBe(text)
  })
  it('recovers its verified pending hard link after final-name publication is interrupted', async () => {
    const { input, text } = await fixture()
    const original = files.syncDatabasePath
    const sync = vi.spyOn(files, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path === dirname(input.target)) throw new Error('published sync failed')
      await original(path, directory)
    })
    await expect(publishPluginCopy(input)).rejects.toThrow('published sync failed')
    expect(await readFile(input.target, 'utf8')).toBe(text)
    expect((await stat(input.target)).nlink).toBe(2)
    sync.mockRestore()
    await recoverPluginCopy(input.target, input.directory, input.sha256)
    expect((await stat(input.target)).nlink).toBe(1)
    expect(await readFile(input.target, 'utf8')).toBe(text)
  })
})
