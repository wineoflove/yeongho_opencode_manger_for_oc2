import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupStoppedClaudeDatabases } from '../../src/services/claude-database-backup'
import * as files from '../../src/services/claude-database-files'
import * as publication from '../../src/services/claude-transfer-activate'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'backup-publication-')))
  roots.push(root)
  const manager = join(root, 'manager.db')
  const native = join(root, 'native.db')
  await writeFile(manager, 'synthetic pinned manager bytes', { mode: 0o600 })
  await writeFile(native, 'synthetic pinned native bytes', { mode: 0o600 })
  return {
    root,
    input: {
      destination: join(root, 'backup'),
      manager: {
        path: manager,
        sha256: await files.privateDatabaseDigest(manager),
      },
      native: {
        path: native,
        sha256: await files.privateDatabaseDigest(native),
      },
      assertQuiescent: async () => {},
    },
  }
}
describe('stopped pair backup publication durability', () => {
  it('does not publish completion if the destination parent cannot be synced', async () => {
    const { root, input } = await fixture()
    const original = files.syncDatabasePath
    vi.spyOn(files, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path === root) throw new Error('parent-sync')
      await original(path, directory)
    })
    await expect(backupStoppedClaudeDatabases(input)).rejects.toMatchObject({
      code: 'BACKUP_FAILED',
      published: false,
    })
    await expect(readFile(join(input.destination, 'backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['partial-write', 'after-write-sync'])('does not expose completion on %s failure', async (failure) => {
    const { input } = await fixture()
    vi.spyOn(publication, 'durableTransferRecord').mockImplementation(async (path, record) => {
      const text = JSON.stringify(record)
      await writeFile(path, failure === 'partial-write' ? text.slice(0, 10) : text, { mode: 0o600, flag: 'wx' })
      throw new Error('publication failed')
    })
    await expect(backupStoppedClaudeDatabases(input)).rejects.toMatchObject({
      code: 'BACKUP_FAILED',
      published: false,
    })
    await expect(readFile(join(input.destination, 'backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await files.privateDatabaseDigest(input.manager.path)).toBe(input.manager.sha256)
    expect(await files.privateDatabaseDigest(input.native.path)).toBe(input.native.sha256)
  })
  it('reports a published but unconfirmed ledger if its directory sync fails after rename', async () => {
    const { input } = await fixture()
    const original = files.syncDatabasePath
    vi.spyOn(files, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path === input.destination) throw new Error('published directory sync')
      await original(path, directory)
    })
    await expect(backupStoppedClaudeDatabases(input)).rejects.toMatchObject({
      code: 'BACKUP_DURABILITY_UNCONFIRMED',
      published: true,
    })
    const ledger = JSON.parse(await readFile(join(input.destination, 'backup.json'), 'utf8'))
    expect(ledger.entries.map((entry: { sha256: string }) => entry.sha256)).toEqual([
      input.manager.sha256,
      input.native.sha256,
    ])
  })
})
