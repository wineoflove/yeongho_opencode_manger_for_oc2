import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'

export class ClaudeDatabaseRestoreError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'FILE_CHANGED'
      | 'SIDECAR_PRESENT'
      | 'RESTORE_FAILED'
      | 'FILESYSTEM_MISMATCH'
      | 'LOCK_OWNER_PRESENT',
  ) {
    super(code)
    this.name = 'ClaudeDatabaseRestoreError'
  }
}

export async function privateDatabaseDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o077)
      throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

export async function assertDatabaseSidecarsAbsent(path: string) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(path + suffix)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    throw new ClaudeDatabaseRestoreError('SIDECAR_PRESENT')
  }
}

export async function syncDatabasePath(path: string, directory = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0))
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}
