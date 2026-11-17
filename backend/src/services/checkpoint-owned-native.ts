import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { assertDatabaseFilesUnheld } from './claude-transfer-quiescence'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { durableTransferRecord } from './claude-transfer-activate'

export class NativeCheckpointError extends Error {
  constructor() {
    super('NATIVE_CHECKPOINT_UNVERIFIED')
    this.name = 'NativeCheckpointError'
  }
}

export async function assertOwnedNativeDatabase(input: {
  readonly database: string
  readonly owner: { readonly device: number; readonly inode: number }
}) {
  const entry = await lstat(input.database)
  if (
    !isAbsolute(input.database) ||
    (await realpath(input.database)) !== input.database ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.uid !== process.getuid?.() ||
    entry.mode & 0o077 ||
    entry.dev !== input.owner.device ||
    entry.ino !== input.owner.inode
  )
    throw new NativeCheckpointError()
}

export async function checkpointOwnedNative(input: {
  readonly database: string
  readonly owner: { readonly device: number; readonly inode: number }
  readonly stateDirectory: string
  readonly assertQuiescent: () => Promise<void>
}) {
  const checkIdentity = () => assertOwnedNativeDatabase(input)
  try {
    const state = await lstat(input.stateDirectory)
    if (
      !isAbsolute(input.stateDirectory) ||
      (await realpath(input.stateDirectory)) !== input.stateDirectory ||
      !state.isDirectory() ||
      state.uid !== process.getuid?.() ||
      state.mode & 0o077
    )
      throw new NativeCheckpointError()
    await input.assertQuiescent()
    await checkIdentity()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        const file = await lstat(input.database + suffix)
        if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.mode & 0o077)
          throw new NativeCheckpointError()
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await assertDatabaseFilesUnheld([input.database])
    const id = randomUUID()
    await durableTransferRecord(join(input.stateDirectory, `native-checkpoint-${id}.intent.json`), {
      database: input.database,
      owner: input.owner,
      phase: 'checkpoint-intent',
    })
    await input.assertQuiescent()
    await checkIdentity()
    await assertDatabaseFilesUnheld([input.database])
    const db = new Database(input.database, { create: false })
    let credentialDigest: string
    try {
      await checkIdentity()
      const digest = () =>
        createHash('sha256')
          .update(JSON.stringify(db.query('SELECT id,integration_id,value FROM credential ORDER BY id').all()))
          .digest('hex')
      credentialDigest = digest()
      z.object({ busy: z.literal(0) }).parse(db.query('PRAGMA wal_checkpoint(TRUNCATE)').get())
      z.object({ journal_mode: z.literal('delete') }).parse(db.query('PRAGMA journal_mode=DELETE').get())
      z.object({ quick_check: z.literal('ok') }).parse(db.query('PRAGMA quick_check').get())
      if (digest() !== credentialDigest) throw new NativeCheckpointError()
    } finally {
      db.close()
    }
    await input.assertQuiescent()
    await checkIdentity()
    await assertDatabaseFilesUnheld([input.database])
    try {
      const shm = await lstat(input.database + '-shm')
      if (!shm.isFile() || shm.nlink !== 1 || shm.uid !== process.getuid?.()) throw new NativeCheckpointError()
      await rename(input.database + '-shm', join(input.stateDirectory, `native-checkpoint-${id}.retired-shm`))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await assertDatabaseSidecarsAbsent(input.database)
    await syncDatabasePath(input.database)
    await syncDatabasePath(dirname(input.database), true)
    await syncDatabasePath(input.stateDirectory, true)
    const sha256 = await privateDatabaseDigest(input.database)
    await durableTransferRecord(join(input.stateDirectory, `native-checkpoint-${id}.complete.json`), {
      phase: 'checkpoint-complete',
      database: input.database,
      owner: input.owner,
      sha256,
      credentialDigest,
    })
    return { sha256 }
  } catch {
    throw new NativeCheckpointError()
  }
}
