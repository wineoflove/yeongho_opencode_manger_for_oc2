import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { predictCutoverCommit } from '../../src/services/cutover-commit-reference'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'

it.each([false, true])('publishes the predicted commit only after actual steps succeed (fail=%s)', async (fail) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'commit-reference-')))
  const payload = root + '.payload'
  try {
    const reference = await predictCutoverCommit(root, ['write-fixture', 'verify-fixture'])
    expect(await readdir(root)).toEqual([])
    expect(reference.activationAuthorized).toBe(false)
    const journal = await openCutoverJournal(root)
    try {
      const operation = runCutoverSteps({
        persist: journal.persist,
        steps: [
          {
            name: 'write-fixture',
            forward: async () => {
              await writeFile(payload, 'written')
            },
            rollback: async () => {
              await rm(payload)
            },
          },
          {
            name: 'verify-fixture',
            forward: async () => {
              expect(await readFile(payload, 'utf8')).toBe('written')
              if (fail) throw new Error('synthetic-failure')
            },
            rollback: async () => {},
          },
        ],
      })
      if (fail) {
        await expect(operation).rejects.toMatchObject({
          rollback: 'verified',
        })
        const atPredictedPath = await readFile(reference.path, 'utf8')
        expect(createHash('sha256').update(atPredictedPath).digest('hex')).not.toBe(reference.sha256)
        expect(JSON.parse(atPredictedPath).state.phase).not.toBe('committed')
      } else {
        await operation
        expect(
          createHash('sha256')
            .update(await readFile(reference.path))
            .digest('hex'),
        ).toBe(reference.sha256)
        expect(JSON.parse(await readFile(reference.path, 'utf8')).state.phase).toBe('committed')
      }
    } finally {
      await journal.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(payload, { force: true })
  }
})
