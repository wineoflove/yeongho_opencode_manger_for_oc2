import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { managerDatabaseCutoverStep } from '../../src/services/cutover-manager-database-step'
import { privateDatabaseDigest } from '../../src/services/claude-database-files'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([false, true])(
  'restores exact Manager database bytes after later failure with residual journal=%s',
  async (sidecar) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-step-')))
    roots.push(root)
    const database = join(root, 'manager.db')
    const backupDirectory = join(root, 'backup')
    const journalDirectory = join(root, 'journal')
    await mkdir(backupDirectory, { mode: 0o700 })
    await mkdir(journalDirectory, { mode: 0o700 })
    expect(
      spawnSync('/usr/bin/sqlite3', [
        database,
        'CREATE TABLE settings(value TEXT); INSERT INTO settings VALUES ("preserved");',
      ]).status,
    ).toBe(0)
    await chmod(database, 0o600)
    const originalSha256 = await privateDatabaseDigest(database)
    const step = managerDatabaseCutoverStep({
      database,
      backup: join(backupDirectory, 'manager.db'),
      originalSha256,
      retireId: 'owned-migration-rollback',
      assertQuiescent: async () => {},
    })
    const journal = await openCutoverJournal(journalDirectory)
    try {
      await expect(
        runCutoverSteps({
          persist: journal.persist,
          steps: [
            step,
            {
              name: 'migration',
              forward: async () => {
                expect(
                  spawnSync('/usr/bin/sqlite3', [database, 'ALTER TABLE settings ADD COLUMN migrated TEXT;']).status,
                ).toBe(0)
                expect(await privateDatabaseDigest(database)).not.toBe(originalSha256)
                if (sidecar) await writeFile(database + '-journal', 'synthetic residual journal', { mode: 0o600 })
                throw new Error('synthetic-health-failure')
              },
              rollback: async () => {},
            },
          ],
        }),
      ).rejects.toMatchObject({ rollback: 'verified' })
      expect(await privateDatabaseDigest(database)).toBe(originalSha256)
      if (sidecar)
        expect(await readFile(database + '-journal.retired-owned-migration-rollback', 'utf8')).toBe(
          'synthetic residual journal',
        )
      await step.rollback()
      expect(await privateDatabaseDigest(database)).toBe(originalSha256)
    } finally {
      await journal.close()
    }
  },
)
