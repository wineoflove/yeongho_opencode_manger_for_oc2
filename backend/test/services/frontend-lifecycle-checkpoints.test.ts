import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { releaseLifecycleCheckpoints } from '../../src/services/release-lifecycle-checkpoints'

it('binds an observed frontend to its original definition and restores its newer maintenance snapshot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'frontend-checkpoints-')))
  try {
    const directory = join(root, 'events')
    const snapshotDirectory = join(root, 'snapshots')
    await mkdir(directory, { mode: 0o700 })
    await mkdir(snapshotDirectory, { mode: 0o700 })
    const original = {
      path: join(root, 'original.plist'),
      sha256: 'a'.repeat(64),
    }
    const target = {
      label: 'io.wineoflove.ocm.frontend',
      port: 5173,
      ownedPorts: [],
      treeStop: true,
      initialDefinition: original,
      sourceDefinition: original,
    }
    const input = { directory, snapshotDirectory, targets: [target] }
    const store = await releaseLifecycleCheckpoints(input)
    const observed = {
      label: target.label,
      port: target.port,
      pids: [1234],
      registered: true,
      definition: original.path,
      definitionSha256: original.sha256,
      sourceDefinition: original.path,
      sourceDefinitionSha256: original.sha256,
      expectedPID: 1234,
      expectedStarted: 'Sun Nov 15 10:00:00 2026',
    }
    const maintained = {
      ...observed,
      definition: join(snapshotDirectory, 'launchd-definition-11111111-1111-4111-8111-111111111111.plist'),
      definitionSha256: 'b'.repeat(64),
      pids: [1234, 5678],
    }
    try {
      await expect(
        store.persist({
          phase: 'observed-existing',
          recordedAt: 1,
          unit: { ...observed, sourceDefinition: '/foreign' },
        }),
      ).rejects.toThrow('RELEASE_CHECKPOINT_SCOPE_REJECTED')
      await store.persist({
        phase: 'observed-existing',
        recordedAt: 1,
        unit: observed,
      })
      await store.persist({ phase: 'ready', recordedAt: 2, unit: maintained })
    } finally {
      await store.close()
    }
    const reopened = await releaseLifecycleCheckpoints(input)
    try {
      expect(reopened.latest(target.label)).toEqual(maintained)
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
