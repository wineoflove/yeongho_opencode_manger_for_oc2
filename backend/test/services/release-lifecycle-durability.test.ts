import { mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { releaseLifecycleCheckpoints } from '../../src/services/release-lifecycle-checkpoints'
import { CutoverPublicationUncertainError } from '../../src/services/cutover-publication-error'
import * as durability from '../../src/services/claude-database-files'

it.each(['directory-swap', 'post-publish-sync'])('fails closed and permits disk rehydration for %s', async (mode) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lifecycle-durability-')))
  const directory = join(root, 'events')
  await mkdir(directory, { mode: 0o700 })
  const input = {
    directory,
    snapshotDirectory: root,
    targets: [{ label: 'owned', port: 5134, ownedPorts: [] }],
  }
  const store = await releaseLifecycleCheckpoints(input)
  const unit = {
    label: 'owned',
    port: 5134,
    pids: [1234],
    registered: true,
    stopScope: 'owner' as const,
    definition: join(root, 'launchd-definition-11111111-1111-4111-8111-111111111111.plist'),
    definitionSha256: 'a'.repeat(64),
  }
  try {
    if (mode === 'directory-swap') {
      await rename(directory, join(root, 'original-events'))
      await mkdir(directory, { mode: 0o700 })
      await expect(store.persist({ phase: 'ready', recordedAt: 1, unit })).rejects.toThrow(
        'RELEASE_CHECKPOINT_SCOPE_REJECTED',
      )
      expect(await readdir(directory)).toEqual([])
    } else {
      const original = durability.syncDatabasePath
      const failing = vi.spyOn(durability, 'syncDatabasePath').mockImplementation(async (path, isDirectory) => {
        if (path === directory) throw new Error('synthetic-directory-sync-failure')
        await original(path, isDirectory)
      })
      await expect(store.persist({ phase: 'ready', recordedAt: 1, unit })).rejects.toBeInstanceOf(
        CutoverPublicationUncertainError,
      )
      await expect(store.persist({ phase: 'stopped', recordedAt: 2, unit })).rejects.toThrow(
        'RELEASE_CHECKPOINT_WRITE_BUSY',
      )
      failing.mockRestore()
      await store.close()
      const resumed = await releaseLifecycleCheckpoints(input)
      try {
        expect(resumed.latest('owned')).toEqual(unit)
        await resumed.persist({
          phase: 'stopped',
          recordedAt: 2,
          unit: { ...unit, registered: false },
        })
        expect((await readdir(directory)).sort()).toEqual(['000001.json', '000002.json'])
      } finally {
        await resumed.close()
      }
    }
  } finally {
    vi.restoreAllMocks()
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})
