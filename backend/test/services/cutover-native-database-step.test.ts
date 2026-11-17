import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nativeDatabaseCutoverStep } from '../../src/services/cutover-native-database-step'
import { privateDatabaseDigest } from '../../src/services/claude-database-files'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'

it.each([false, true])(
  'preserves refreshed native data until credentials return succeeds (failure=%s)',
  async (failReturn) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-step-')))
    try {
      const staged = join(root, 'staged.db')
      const target = join(root, 'native.db')
      const stateDirectory = join(root, 'state')
      const journalDirectory = join(root, 'journal')
      await mkdir(stateDirectory, { mode: 0o700 })
      await mkdir(journalDirectory, { mode: 0o700 })
      expect(
        spawnSync('/usr/bin/sqlite3', [
          staged,
          'CREATE TABLE credential(value TEXT); INSERT INTO credential VALUES("old");',
        ]).status,
      ).toBe(0)
      await chmod(staged, 0o600)
      const install = {
        staged,
        target,
        stagedSha256: await privateDatabaseDigest(staged),
        assertQuiescent: async () => {},
      }
      let returned = ''
      const step = nativeDatabaseCutoverStep({
        install,
        stateDirectory,
        retireId: 'native-step-recovery',
        returnCredentials: async () => {
          if (failReturn) throw new Error('synthetic-return-failure')
          returned = spawnSync('/usr/bin/sqlite3', [target, 'SELECT value FROM credential'], {
            encoding: 'utf8',
          }).stdout.trim()
        },
      })
      const journal = await openCutoverJournal(journalDirectory)
      try {
        await expect(
          runCutoverSteps({
            persist: journal.persist,
            steps: [
              step,
              {
                name: 'postflight',
                forward: async () => {
                  expect(spawnSync('/usr/bin/sqlite3', [target, 'UPDATE credential SET value="latest";']).status).toBe(
                    0,
                  )
                  throw new Error('synthetic-postflight-failure')
                },
                rollback: async () => {},
              },
            ],
          }),
        ).rejects.toMatchObject({
          rollback: failReturn ? 'unverified' : 'verified',
        })
        const path = failReturn ? target : `${target}.retired-native-step-recovery`
        expect(
          spawnSync('/usr/bin/sqlite3', [path, 'SELECT value FROM credential'], { encoding: 'utf8' }).stdout.trim(),
        ).toBe('latest')
        expect(returned).toBe(failReturn ? '' : 'latest')
        if (!failReturn) await step.rollback()
      } finally {
        await journal.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('refuses to retire an unrelated replacement even when its bytes match', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-step-owner-')))
  try {
    const staged = join(root, 'staged.db')
    const target = join(root, 'native.db')
    const stateDirectory = join(root, 'state')
    await mkdir(stateDirectory, { mode: 0o700 })
    expect(spawnSync('/usr/bin/sqlite3', [staged, 'CREATE TABLE sentinel(id INTEGER);']).status).toBe(0)
    await chmod(staged, 0o600)
    let returned = false
    const step = nativeDatabaseCutoverStep({
      install: {
        staged,
        target,
        stagedSha256: await privateDatabaseDigest(staged),
        assertQuiescent: async () => {},
      },
      stateDirectory,
      retireId: 'owned-target-check',
      returnCredentials: async () => {
        returned = true
      },
    })
    await step.forward()
    await rename(target, join(root, 'owned.db'))
    await expect(step.rollback()).rejects.toMatchObject({
      code: 'OWNERSHIP_UNVERIFIED',
    })
    expect(returned).toBe(false)
    await copyFile(staged, target)
    await expect(step.rollback()).rejects.toMatchObject({
      code: 'OWNERSHIP_UNVERIFIED',
    })
    expect(returned).toBe(false)
    expect(await readFile(target)).toEqual(await readFile(staged))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
