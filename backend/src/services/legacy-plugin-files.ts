import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { syncDatabasePath } from './claude-database-files'

export class LegacyPluginTransitionError extends Error {
  constructor(
    readonly code: 'INVALID_SCOPE' | 'FILE_CHANGED' | 'MISSING_ORIGINAL' | 'JOURNAL_MISMATCH' | 'TRANSITION_FAILED',
  ) {
    super(code)
    this.name = 'LegacyPluginTransitionError'
  }
}

export async function pluginIdentity(path: string, expected: string, links = 1) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== links ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 1024 * 1024
    )
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    const data = await file.readFile()
    const after = await file.stat()
    if (
      createHash('sha256').update(data).digest('hex') !== expected ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new LegacyPluginTransitionError('FILE_CHANGED')
    return `${stat.dev}:${stat.ino}`
  } finally {
    await file.close()
  }
}

export async function recoverPluginCopy(
  target: string,
  pendingDirectory: string,
  expected: string | { readonly sha256: string; readonly identity: string },
) {
  const sha256 = typeof expected === 'string' ? expected : expected.sha256
  let stat
  try {
    stat = await lstat(target)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (stat.nlink === 1) return
  if (stat.nlink !== 2) throw new LegacyPluginTransitionError('INVALID_SCOPE')
  const identity = await pluginIdentity(target, sha256, 2)
  if (typeof expected !== 'string' && identity !== expected.identity)
    throw new LegacyPluginTransitionError('FILE_CHANGED')
  const candidates = (await readdir(pendingDirectory)).filter((name) =>
    /^\.plugin-pending-[a-f0-9-]{36}\.bin$/.test(name),
  )
  const matches = []
  for (const name of candidates) {
    const path = join(pendingDirectory, name)
    const pending = await lstat(path)
    if (pending.dev === stat.dev && pending.ino === stat.ino) matches.push(path)
  }
  if (matches.length !== 1) throw new LegacyPluginTransitionError('INVALID_SCOPE')
  const pending = matches[0]
  if (!pending || (await pluginIdentity(pending, sha256, 2)) !== identity)
    throw new LegacyPluginTransitionError('FILE_CHANGED')
  await unlink(pending)
  await syncDatabasePath(pendingDirectory, true)
  await syncDatabasePath(target)
}

export async function publishPluginCopy(input: {
  readonly source: string
  readonly target: string
  readonly directory: string
  readonly sha256: string
  readonly recordOwnership?: (identity: string) => Promise<void>
}) {
  const pending = join(input.directory, `.plugin-pending-${randomUUID()}.bin`)
  await copyFile(input.source, pending, constants.COPYFILE_EXCL)
  const identity = await pluginIdentity(pending, input.sha256)
  if (!identity) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
  await syncDatabasePath(pending)
  await syncDatabasePath(input.directory, true)
  await input.recordOwnership?.(identity)
  if ((await pluginIdentity(pending, input.sha256)) !== identity) throw new LegacyPluginTransitionError('FILE_CHANGED')
  await link(pending, input.target)
  await syncDatabasePath(dirname(input.target), true)
  await unlink(pending)
  await syncDatabasePath(input.directory, true)
}
