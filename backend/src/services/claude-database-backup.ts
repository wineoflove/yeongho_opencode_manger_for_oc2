import { constants, type Stats } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { durableTransferRecord } from './claude-transfer-activate'

type Source = { readonly path: string; readonly sha256: string }
export class ClaudeDatabaseBackupError extends Error {
  constructor(
    readonly code:
      'INVALID_SCOPE' | 'SOURCE_IN_USE' | 'SOURCE_CHANGED' | 'BACKUP_FAILED' | 'BACKUP_DURABILITY_UNCONFIRMED',
    readonly published = false,
  ) {
    super(code)
    this.name = 'ClaudeDatabaseBackupError'
  }
}

export async function backupStoppedClaudeDatabases(input: {
  readonly destination: string
  readonly manager: Source
  readonly native: Source
  readonly assertQuiescent: () => Promise<void>
}) {
  try {
    const sources = [
      ['manager', input.manager],
      ['opencode', input.native],
    ] as const
    if (
      !isAbsolute(input.destination) ||
      input.manager.path === input.native.path ||
      sources.some(([, source]) => !isAbsolute(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256))
    )
      throw new ClaudeDatabaseBackupError('INVALID_SCOPE')
    const parent = dirname(input.destination)
    const parentIdentity = await lstat(parent)
    if (
      (await realpath(parent)) !== parent ||
      !parentIdentity.isDirectory() ||
      parentIdentity.uid !== process.getuid?.() ||
      (parentIdentity.mode & 0o077) !== 0
    )
      throw new ClaudeDatabaseBackupError('INVALID_SCOPE')
    const identities = new Map<string, Stats>()
    for (const [, source] of sources) {
      if ((await realpath(source.path)) !== source.path) throw new ClaudeDatabaseBackupError('INVALID_SCOPE')
      identities.set(source.path, await lstat(source.path))
    }
    const assertSources = async () => {
      await input.assertQuiescent()
      const currentParent = await lstat(parent)
      if (
        (await realpath(parent)) !== parent ||
        currentParent.ino !== parentIdentity.ino ||
        currentParent.dev !== parentIdentity.dev ||
        !currentParent.isDirectory() ||
        currentParent.uid !== process.getuid?.() ||
        (currentParent.mode & 0o077) !== 0
      )
        throw new ClaudeDatabaseBackupError('INVALID_SCOPE')
      for (const [, source] of sources) {
        const current = await lstat(source.path)
        const before = identities.get(source.path)
        if (
          !before ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          (await realpath(source.path)) !== source.path
        )
          throw new ClaudeDatabaseBackupError('SOURCE_CHANGED')
        await assertDatabaseSidecarsAbsent(source.path)
        const handles = spawnSync('/usr/sbin/lsof', ['-t', '--', source.path], {
          encoding: 'utf8',
          timeout: 5000,
        })
        if (handles.error || handles.signal || handles.status !== 1 || handles.stdout.trim() || handles.stderr.trim())
          throw new ClaudeDatabaseBackupError('SOURCE_IN_USE')
        if ((await privateDatabaseDigest(source.path)) !== source.sha256)
          throw new ClaudeDatabaseBackupError('SOURCE_CHANGED')
      }
    }
    await assertSources()
    await mkdir(input.destination, { mode: 0o700 })
    await syncDatabasePath(parent, true)
    const outputIdentity = await lstat(input.destination)
    const entries = []
    for (const [name, source] of sources) {
      const target = join(input.destination, `${name}.db`)
      await copyFile(source.path, target, constants.COPYFILE_EXCL)
      if ((await privateDatabaseDigest(target)) !== source.sha256) throw new ClaudeDatabaseBackupError('SOURCE_CHANGED')
      await syncDatabasePath(target)
      entries.push({
        name,
        source: source.path,
        path: target,
        sha256: source.sha256,
      })
    }
    await assertSources()
    const output = await lstat(input.destination)
    if (
      (await realpath(input.destination)) !== input.destination ||
      output.ino !== outputIdentity.ino ||
      output.dev !== outputIdentity.dev ||
      !output.isDirectory() ||
      output.uid !== process.getuid?.() ||
      (output.mode & 0o077) !== 0
    )
      throw new ClaudeDatabaseBackupError('INVALID_SCOPE')
    for (const entry of entries) {
      await assertDatabaseSidecarsAbsent(entry.path)
      if ((await privateDatabaseDigest(entry.path)) !== entry.sha256)
        throw new ClaudeDatabaseBackupError('SOURCE_CHANGED')
    }
    const ledger = {
      version: 1,
      phase: 'stopped-databases-backed-up',
      recordedAt: Date.now(),
      entries,
      sourceWrites: 0,
    }
    const pending = join(input.destination, `backup.pending-${randomUUID()}.json`)
    await durableTransferRecord(pending, ledger)
    await rename(pending, join(input.destination, 'backup.json'))
    try {
      await syncDatabasePath(input.destination, true)
    } catch {
      throw new ClaudeDatabaseBackupError('BACKUP_DURABILITY_UNCONFIRMED', true)
    }
    return ledger
  } catch (error) {
    throw error instanceof ClaudeDatabaseBackupError ? error : new ClaudeDatabaseBackupError('BACKUP_FAILED')
  }
}
