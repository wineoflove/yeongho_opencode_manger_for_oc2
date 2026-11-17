import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { releaseLifecycleCheckpoints } from '../../src/services/release-lifecycle-checkpoints'

it('restores the last owned unit, rejects a second writer and detects a changed history', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-checkpoints-')))
  try {
    const directory = join(root, 'events')
    await mkdir(directory, { mode: 0o700 })
    const input = {
      directory,
      snapshotDirectory: root,
      targets: [{ label: 'owned', port: 5134, ownedPorts: [5135] }],
    }
    const store = await releaseLifecycleCheckpoints(input)
    const unit = {
      label: 'owned',
      port: 5134,
      ownedPorts: [5135],
      stopScope: 'owner' as const,
      pids: [1234],
      registered: true,
      definition: join(root, 'launchd-definition-11111111-1111-4111-8111-111111111111.plist'),
      definitionSha256: 'a'.repeat(64),
    }
    try {
      await expect(releaseLifecycleCheckpoints(input)).rejects.toThrow()
      await expect(
        store.persist({
          phase: 'ready',
          recordedAt: 1,
          unit: { ...unit, port: 5101 },
        }),
      ).rejects.toThrow('RELEASE_CHECKPOINT_SCOPE_REJECTED')
      await store.persist({ phase: 'ready', recordedAt: 1, unit })
      await store.persist({
        phase: 'stopped',
        recordedAt: 2,
        unit: { ...unit, registered: false, survivingDescendants: 0 },
      })
    } finally {
      await store.close()
    }
    const restored = await releaseLifecycleCheckpoints(input)
    try {
      expect(restored.latest('owned')).toEqual({
        ...unit,
        registered: false,
        survivingDescendants: 0,
      })
    } finally {
      await restored.close()
    }
    const first = join(directory, '000001.json')
    const changed = JSON.parse(await readFile(first, 'utf8'))
    changed.checkpoint.recordedAt = 3
    await writeFile(first, JSON.stringify(changed))
    await expect(releaseLifecycleCheckpoints(input)).rejects.toThrow('RELEASE_CHECKPOINT_CHAIN_REJECTED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
