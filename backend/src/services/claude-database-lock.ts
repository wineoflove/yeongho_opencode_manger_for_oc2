import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { ClaudeDatabaseRestoreError, syncDatabasePath } from './claude-database-files'

const ownerSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    pid: z.number().int().min(2),
    createdAt: z.number().int().positive(),
  })
  .strict()

export async function acquireClaudeDatabaseLock(directory: string) {
  const lock = `${directory}.lock`
  const owner = {
    version: 1,
    id: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  }
  const pending = `${lock}.pending-${owner.id}`
  await mkdir(pending, { mode: 0o700 })
  await durableTransferRecord(join(pending, 'owner.json'), owner)
  try {
    await lstat(lock)
    throw new ClaudeDatabaseRestoreError('LOCK_OWNER_PRESENT')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  try {
    await rename(pending, lock)
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code)))
      throw new ClaudeDatabaseRestoreError('LOCK_OWNER_PRESENT')
    throw error
  }
  await syncDatabasePath(dirname(lock), true)
  return async () => {
    const current = ownerSchema.parse(JSON.parse(await readPrivateTransferFile(join(lock, 'owner.json'))))
    if (current.id !== owner.id || current.pid !== process.pid)
      throw new ClaudeDatabaseRestoreError('LOCK_OWNER_PRESENT')
    await rename(lock, `${lock}.released-${owner.id}`)
    await syncDatabasePath(dirname(lock), true)
  }
}

function assertOwnerExited(pid: number) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw new ClaudeDatabaseRestoreError('LOCK_OWNER_PRESENT')
  }
  throw new ClaudeDatabaseRestoreError('LOCK_OWNER_PRESENT')
}

export async function recoverClaudeDatabaseLock(directory: string, assertQuiescent: () => Promise<void>) {
  if (!isAbsolute(directory) || (await realpath(dirname(directory))) !== dirname(directory))
    throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  const lock = `${directory}.lock`
  await assertQuiescent()
  const metadata = await lstat(lock)
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(lock)) !== lock
  )
    throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  const text = await readPrivateTransferFile(join(lock, 'owner.json'))
  const owner = ownerSchema.parse(JSON.parse(text))
  assertOwnerExited(owner.pid)
  await assertQuiescent()
  const current = await lstat(lock)
  if (
    current.dev !== metadata.dev ||
    current.ino !== metadata.ino ||
    (await readPrivateTransferFile(join(lock, 'owner.json'))) !== text
  )
    throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
  assertOwnerExited(owner.pid)
  const archive = `${lock}.retired-${owner.id}`
  await rename(lock, archive)
  await syncDatabasePath(dirname(lock), true)
  return {
    phase: 'lock-retired',
    ownerPID: owner.pid,
    archive,
    servicesRestarted: false,
  }
}
