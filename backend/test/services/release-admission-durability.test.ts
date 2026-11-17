import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareReleaseAdmission } from '../../../../bin/prepare-release-admission.mjs'
import { openReleaseAdmission } from '../../../../bin/open-release-admission.mjs'
import { executePinnedCutover } from '../../src/services/execute-pinned-cutover'
import { predictCutoverCommit } from '../../src/services/cutover-commit-reference'
import { MaintenanceAdmission } from '../../src/services/maintenance-admission'

const fault = vi.hoisted(() => ({ write: '', sync: '' }))
vi.mock('../../src/services/claude-transfer-activate', async (original) => {
  const actual = await original<typeof import('../../src/services/claude-transfer-activate')>()
  return {
    ...actual,
    durableTransferRecord: async (path: string, value: unknown) => {
      if (fault.write && path.endsWith(fault.write)) {
        await writeFile(path, JSON.stringify(value), {
          mode: 0o600,
          flag: 'wx',
        })
        throw new Error('fixture-write-before-sync-failure')
      }
      return actual.durableTransferRecord(path, value)
    },
  }
})
vi.mock('../../src/services/claude-database-files', async (original) => {
  const actual = await original<typeof import('../../src/services/claude-database-files')>()
  return {
    ...actual,
    syncDatabasePath: async (path: string, directory?: boolean) => {
      if (fault.sync && path.endsWith(fault.sync)) throw new Error('fixture-sync-failure')
      return actual.syncDatabasePath(path, directory)
    },
  }
})

it.each(['open-intent.json', 'opened-receipt.json'])(
  'retries durability of existing %s instead of treating readable content as synced',
  async (file) => {
    const root = await mkdtemp('/Users/yeonghokim/apps/ocm-v2-staging/run/release-package-')
    const stateDirectory = await mkdtemp('/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-')
    try {
      const marker = await prepareReleaseAdmission(root)
      const admission = new MaintenanceAdmission(marker.path)
      const journalDirectory = join(stateDirectory, 'journal')
      await mkdir(journalDirectory, { mode: 0o700 })
      const expectedCommit = await predictCutoverCommit(journalDirectory, ['postflight'])
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const manifest = JSON.stringify({ root, admission: marker })
      const references = {
        release: { path: join(root, 'manifest.json'), sha256: hash(manifest) },
      }
      const planIdentity = hash(JSON.stringify(references))
      await writeFile(references.release.path, manifest, { mode: 0o600 })
      await writeFile(
        join(stateDirectory, 'operational-recovery.json'),
        JSON.stringify({ planIdentity, expectedCommit, references }),
        { mode: 0o600 },
      )
      await executePinnedCutover({
        mode: 'apply',
        stateDirectory,
        journalDirectory,
        expectedCommit,
        planIdentity,
        assertReady: async () => {},
        steps: [
          {
            name: 'postflight',
            forward: async () => {},
            rollback: async () => {},
          },
        ],
      })
      const input = {
        marker,
        stateDirectory,
        expectedCommit,
        planIdentity,
        assertReady: async () => {},
      }
      fault.write = file
      await expect(openReleaseAdmission(input)).rejects.toMatchObject({
        activationCommitted: true,
      })
      fault.write = ''
      fault.sync = file
      await expect(openReleaseAdmission(input)).rejects.toMatchObject({
        activationCommitted: true,
      })
      expect(admission.isClosed()).toBe(file === 'open-intent.json')
      fault.sync = ''
      await expect(openReleaseAdmission(input)).resolves.toMatchObject({
        state: 'admission-opened-after-commit',
      })
      expect(admission.isClosed()).toBe(false)
    } finally {
      fault.write = ''
      fault.sync = ''
      await rm(root, { recursive: true })
      await rm(stateDirectory, { recursive: true })
    }
  },
)
