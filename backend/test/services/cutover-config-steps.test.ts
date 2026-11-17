import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configurationCutoverSteps } from '../../src/services/cutover-config-steps'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'
import { recoverCutoverSteps, runCutoverSteps } from '../../src/services/cutover-step-runner'

const roots: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'config-cutover-')))
  roots.push(root)
  const directory = join(root, 'journal')
  await mkdir(directory, { mode: 0o700 })
  const configurations = await Promise.all(
    (['global', 'assistant'] as const).map(async (name) => {
      const folder = join(root, name)
      const archiveDirectory = join(root, `${name}-archive`)
      await mkdir(folder, { mode: 0o700 })
      await mkdir(archiveDirectory, { mode: 0o700 })
      const target = join(folder, 'opencode.json')
      const original = JSON.stringify({ name, version: 'old' })
      const candidate = JSON.stringify({ name, version: 'new' })
      await writeFile(target, original, { mode: 0o600 })
      await chmod(target, name === 'assistant' ? 0o664 : 0o600)
      return {
        name,
        original,
        input: {
          target,
          archiveDirectory,
          originalSha256: hash(original),
          candidate,
          candidateSha256: hash(candidate),
          assertQuiescent: async () => {},
        },
      }
    }),
  )
  return {
    directory,
    configurations,
    steps: configurationCutoverSteps(configurations),
  }
}

describe('configuration steps with persistent cutover journal', () => {
  it('restores both real files and modes when a later service step fails', async () => {
    const f = await fixture()
    const store = await openCutoverJournal(f.directory)
    try {
      await expect(
        runCutoverSteps({
          persist: store.persist,
          steps: [
            ...f.steps,
            {
              name: 'service-start',
              forward: async () => {
                throw new Error('synthetic-start-failure')
              },
              rollback: async () => {},
            },
          ],
        }),
      ).rejects.toMatchObject({ rollback: 'verified' })
      for (const entry of f.configurations) {
        expect(await readFile(entry.input.target, 'utf8')).toBe(entry.original)
        expect((await stat(entry.input.target)).mode & 0o777).toBe(entry.name === 'assistant' ? 0o664 : 0o600)
      }
    } finally {
      await store.close()
    }
  })

  it('reopens the journal and restores an applied file whose done receipt was never written', async () => {
    const f = await fixture()
    const first = f.steps[0]
    if (!first) throw new Error('missing-step')
    const store = await openCutoverJournal(f.directory)
    try {
      await store.persist({
        version: 1,
        plan: f.steps.map((step) => step.name),
        phase: 'forward',
        started: 1,
        completed: 0,
        undone: 0,
      })
      await first.forward()
    } finally {
      await store.close()
    }
    const resumed = await openCutoverJournal(f.directory)
    try {
      expect(
        (
          await recoverCutoverSteps({
            steps: f.steps,
            journal: resumed.latest(),
            persist: resumed.persist,
          })
        ).phase,
      ).toBe('restored')
      for (const entry of f.configurations) expect(await readFile(entry.input.target, 'utf8')).toBe(entry.original)
    } finally {
      await resumed.close()
    }
  })

  it('halts rollback rather than overwriting a foreign edit after deployment', async () => {
    const f = await fixture()
    const last = f.configurations[1]
    if (!last) throw new Error('missing-config')
    const store = await openCutoverJournal(f.directory)
    try {
      await expect(
        runCutoverSteps({
          persist: store.persist,
          steps: [
            ...f.steps,
            {
              name: 'service-start',
              forward: async () => {
                await writeFile(last.input.target, '{"user":"changed"}')
                throw new Error('synthetic-start-failure')
              },
              rollback: async () => {},
            },
          ],
        }),
      ).rejects.toMatchObject({
        step: 'config-assistant',
        rollback: 'unverified',
      })
      expect(await readFile(last.input.target, 'utf8')).toBe('{"user":"changed"}')
    } finally {
      await store.close()
    }
  })
})
