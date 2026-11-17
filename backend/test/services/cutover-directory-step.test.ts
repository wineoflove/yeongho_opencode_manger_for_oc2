import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { newDirectoryCutoverStep } from '../../src/services/cutover-directory-step'

it('preserves a foreign retirement destination created during the final quiescence check', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'directory-retire-race-')))
  try {
    const stateDirectory = join(root, 'state')
    const target = join(root, 'plugins')
    const retired = join(stateDirectory, 'directory.retired')
    await mkdir(stateDirectory, { mode: 0o700 })
    let checks = 0
    let foreignInode: number | undefined
    const step = newDirectoryCutoverStep({
      target,
      stateDirectory,
      assertQuiescent: async () => {
        if (++checks === 3) {
          await mkdir(retired, { mode: 0o700 })
          foreignInode = (await lstat(retired)).ino
        }
      },
    })
    await step.forward()
    const original = (await lstat(target)).ino
    await expect(step.rollback()).rejects.toThrow('OWNED_DIRECTORY_UNVERIFIED')
    expect(foreignInode).toBeDefined()
    expect((await lstat(retired)).ino).toBe(foreignInode)
    expect((await lstat(target)).ino).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['owned-empty', 'foreign-content', 'preexisting'])(
  'preserves directory ownership during %s rollback',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cutover-directory-')))
    try {
      const stateDirectory = join(root, 'state')
      const target = join(root, 'plugins')
      await mkdir(stateDirectory, { mode: 0o700 })
      const step = newDirectoryCutoverStep({
        target,
        stateDirectory,
        assertQuiescent: async () => {},
      })
      if (mode === 'preexisting') {
        await mkdir(target, { mode: 0o700 })
        await expect(step.forward()).rejects.toThrow('OWNED_DIRECTORY_UNVERIFIED')
        await step.rollback()
        expect(await readdir(target)).toEqual([])
      } else {
        await step.forward()
        await step.forward()
        if (mode === 'foreign-content') {
          await writeFile(join(target, 'foreign.js'), 'preserve')
          await expect(step.rollback()).rejects.toThrow('OWNED_DIRECTORY_UNVERIFIED')
          expect(await readdir(target)).toEqual(['foreign.js'])
        } else {
          await step.rollback()
          await step.rollback()
          await expect(readdir(target)).rejects.toMatchObject({
            code: 'ENOENT',
          })
          expect(await readdir(join(stateDirectory, 'directory.retired'))).toEqual([])
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
