import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as publication from '../../src/services/claude-transfer-activate'
import * as durability from '../../src/services/claude-database-files'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'
import { recoverCutoverSteps, runCutoverSteps } from '../../src/services/cutover-step-runner'

let root: string
let directory: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cutover-journal-')))
  directory = join(root, 'journal')
  await mkdir(directory, { mode: 0o700 })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const steps = [{ name: 'database', forward: async () => {}, rollback: async () => {} }]

describe('durable cutover journal', () => {
  it('compensates a completed action when a pending receipt is torn before publication', async () => {
    const store = await openCutoverJournal(directory)
    const original = publication.durableTransferRecord
    let writes = 0
    let active = false
    const local = [
      {
        name: 'database',
        forward: async () => {
          active = true
        },
        rollback: async () => {
          active = false
        },
      },
    ]
    vi.spyOn(publication, 'durableTransferRecord').mockImplementation(async (path, record) => {
      if (path.includes('.pending-record-') && ++writes === 2) {
        await writeFile(path, '{', { mode: 0o600 })
        throw new Error('synthetic-partial-write')
      }
      await original(path, record)
    })
    try {
      await expect(runCutoverSteps({ steps: local, persist: store.persist })).rejects.toMatchObject({
        rollback: 'verified',
      })
      expect(active).toBe(false)
    } finally {
      await store.close()
    }
    const reopened = await openCutoverJournal(directory)
    try {
      expect(
        (
          await recoverCutoverSteps({
            steps: local,
            persist: reopened.persist,
            journal: reopened.latest(),
          })
        ).phase,
      ).toBe('restored')
    } finally {
      await reopened.close()
    }
  })

  it('does not rollback an uncertain commit and reads the published commit on reopen', async () => {
    const store = await openCutoverJournal(directory)
    const original = durability.syncDatabasePath
    let syncs = 0
    let active = false
    const local = [
      {
        name: 'database',
        forward: async () => {
          active = true
        },
        rollback: async () => {
          active = false
        },
      },
    ]
    const spy = vi.spyOn(durability, 'syncDatabasePath').mockImplementation(async (path, isDirectory) => {
      if (path === directory && ++syncs === 3) throw new Error('synthetic-sync-failure')
      await original(path, isDirectory)
    })
    try {
      await expect(runCutoverSteps({ steps: local, persist: store.persist })).rejects.toThrow(
        'CUTOVER_PUBLICATION_UNCERTAIN',
      )
      expect(active).toBe(true)
    } finally {
      spy.mockRestore()
      await store.close()
    }
    const reopened = await openCutoverJournal(directory)
    try {
      expect(
        (
          await recoverCutoverSteps({
            steps: local,
            persist: reopened.persist,
            journal: reopened.latest(),
          })
        ).phase,
      ).toBe('committed')
      expect(active).toBe(true)
    } finally {
      await reopened.close()
    }
  })

  it('reads committed state after closing and reopening without replaying forward work', async () => {
    const store = await openCutoverJournal(directory)
    try {
      await runCutoverSteps({ steps, persist: store.persist })
    } finally {
      await store.close()
    }
    const reopened = await openCutoverJournal(directory)
    try {
      const result = await recoverCutoverSteps({
        steps,
        persist: reopened.persist,
        journal: reopened.latest(),
      })
      expect(result.phase).toBe('committed')
      expect(result.completed).toBe(1)
    } finally {
      await reopened.close()
    }
  })

  it.each(['truncated', 'gap', 'changed'])(
    'rejects a %s receipt instead of guessing the last safe state',
    async (kind) => {
      const store = await openCutoverJournal(directory)
      try {
        await runCutoverSteps({ steps, persist: store.persist })
      } finally {
        await store.close()
      }
      switch (kind) {
        case 'truncated':
          await writeFile(join(directory, '000004.json'), '{')
          break
        case 'gap':
          await unlink(join(directory, '000002.json'))
          break
        case 'changed': {
          const first = join(directory, '000001.json')
          await writeFile(first, (await readFile(first, 'utf8')) + ' ')
          break
        }
      }
      await expect(openCutoverJournal(directory)).rejects.toMatchObject({
        code: 'INVALID_CHAIN',
      })
    },
  )

  it('refuses a concurrent owner without permitting a second writer', async () => {
    const store = await openCutoverJournal(directory)
    try {
      await expect(openCutoverJournal(directory)).rejects.toMatchObject({
        code: 'LOCK_OWNER_PRESENT',
      })
      expect((await runCutoverSteps({ steps, persist: store.persist })).phase).toBe('committed')
    } finally {
      await store.close()
    }
  })

  it('recovers an intent-only receipt after reopening', async () => {
    const target = join(root, 'synthetic-change')
    const rollbackSteps = [
      {
        name: 'database',
        forward: async () => {},
        rollback: async () => {
          await unlink(target)
        },
      },
    ]
    const store = await openCutoverJournal(directory)
    try {
      await store.persist({
        version: 1,
        plan: ['database'],
        phase: 'forward',
        started: 1,
        completed: 0,
        undone: 0,
      })
      await writeFile(target, 'partial-step')
    } finally {
      await store.close()
    }
    const reopened = await openCutoverJournal(directory)
    try {
      expect(
        (
          await recoverCutoverSteps({
            steps: rollbackSteps,
            persist: reopened.persist,
            journal: reopened.latest(),
          })
        ).phase,
      ).toBe('restored')
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await reopened.close()
    }
  })
})
