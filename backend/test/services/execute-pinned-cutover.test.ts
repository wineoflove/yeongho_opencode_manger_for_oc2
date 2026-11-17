import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { executePinnedCutover, inspectPinnedCutover } from '../../src/services/execute-pinned-cutover'
import { predictCutoverCommit } from '../../src/services/cutover-commit-reference'
import { CutoverPublicationUncertainError } from '../../src/services/cutover-publication-error'

it.each(['commit', 'recover', 'different-plan'])('executes a pinned journal boundary: %s', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinned-cutover-')))
  try {
    const journalDirectory = join(root, 'journal')
    await mkdir(journalDirectory, { mode: 0o700 })
    const expectedCommit = await predictCutoverCommit(journalDirectory, ['write-fixture'])
    const target = join(root, 'fixture')
    const input = {
      stateDirectory: root,
      journalDirectory,
      expectedCommit,
      planIdentity: 'a'.repeat(64),
      assertReady: async () => {},
      steps: [
        {
          name: mode === 'different-plan' ? 'foreign' : 'write-fixture',
          forward: async () => {
            await writeFile(target, 'owned')
            if (mode === 'recover') throw new CutoverPublicationUncertainError()
          },
          rollback: async () => {
            await rm(target)
          },
        },
      ],
    }
    expect((await inspectPinnedCutover(input)).phase).toBe('not-started')
    const beforeExecution = await readdir(root)
    if (mode === 'different-plan') {
      await expect(executePinnedCutover({ ...input, mode: 'apply' })).rejects.toThrow('CUTOVER_EXECUTION_PLAN_CHANGED')
      expect(await readdir(root)).toEqual(beforeExecution)
    } else if (mode === 'recover') {
      await expect(executePinnedCutover({ ...input, mode: 'apply' })).rejects.toBeInstanceOf(
        CutoverPublicationUncertainError,
      )
      expect(await readFile(target, 'utf8')).toBe('owned')
      expect((await inspectPinnedCutover(input)).phase).toBe('forward')
      await expect(
        executePinnedCutover({
          ...input,
          planIdentity: 'b'.repeat(64),
          mode: 'recover',
        }),
      ).rejects.toThrow('CUTOVER_EXECUTION_BINDING_CHANGED')
      expect((await executePinnedCutover({ ...input, mode: 'recover' })).phase).toBe('restored')
      expect((await inspectPinnedCutover(input)).phase).toBe('restored')
      await expect(readFile(target)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect((await executePinnedCutover({ ...input, mode: 'recover' })).phase).toBe('restored')
    } else {
      expect((await executePinnedCutover({ ...input, mode: 'apply' })).phase).toBe('committed')
      expect((await inspectPinnedCutover(input)).phase).toBe('committed')
      expect((await executePinnedCutover({ ...input, mode: 'recover' })).phase).toBe('committed')
      expect(await readFile(target, 'utf8')).toBe('owned')
      await expect(executePinnedCutover({ ...input, mode: 'apply' })).rejects.toThrow(
        'CUTOVER_EXECUTION_ALREADY_STARTED',
      )
      const committed = await readFile(expectedCommit.path, 'utf8')
      await writeFile(expectedCommit.path, committed + '\n')
      await expect(inspectPinnedCutover(input)).rejects.toBeInstanceOf(CutoverPublicationUncertainError)
      await expect(executePinnedCutover({ ...input, mode: 'recover' })).rejects.toBeInstanceOf(
        CutoverPublicationUncertainError,
      )
      expect(await readFile(target, 'utf8')).toBe('owned')
      await writeFile(expectedCommit.path, committed)
      expect((await executePinnedCutover({ ...input, mode: 'recover' })).phase).toBe('committed')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
