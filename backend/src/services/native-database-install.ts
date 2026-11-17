import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { retireRecordedNativeFiles } from './native-database-retirement'
import { constants } from 'node:fs'
import { copyFile, link, lstat, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { assertDatabaseFilesUnheld } from './claude-transfer-quiescence'

export class NativeDatabaseInstallError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'TARGET_PRESENT' | 'STAGED_CHANGED' | 'INSTALL_UNVERIFIED' | 'TARGET_CHANGED',
  ) {
    super(code)
    this.name = 'NativeDatabaseInstallError'
  }
}

const sidecars = ['-wal', '-shm', '-journal']

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function assertCanonicalDirectory(directory: string, allowGroupWritable = false) {
  const metadata = await lstat(directory)
  if (
    (await realpath(directory)) !== directory ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    metadata.mode & (allowGroupWritable ? 0o002 : 0o022)
  )
    throw new NativeDatabaseInstallError('INVALID_INPUT')
}

export async function installNativeDatabase(input: {
  readonly staged: string
  readonly stagedSha256: string
  readonly target: string
  readonly assertQuiescent: () => Promise<void>
  readonly allowGroupWritableDirectory?: boolean
  readonly recordOwnership?: (identity: { readonly device: number; readonly inode: number }) => Promise<void>
}): Promise<{
  readonly path: string
  readonly sha256: string
  readonly state: 'installed' | 'reused'
  readonly unrelatedTemporaryFiles: number
}> {
  if (
    !isAbsolute(input.staged) ||
    !isAbsolute(input.target) ||
    input.staged === input.target ||
    !/^[a-f0-9]{64}$/.test(input.stagedSha256) ||
    !basename(input.target).endsWith('.db')
  )
    throw new NativeDatabaseInstallError('INVALID_INPUT')
  const directory = dirname(input.target)
  await assertCanonicalDirectory(directory, input.allowGroupWritableDirectory === true)
  if ((await realpath(input.staged)) !== input.staged) throw new NativeDatabaseInstallError('INVALID_INPUT')
  await assertDatabaseSidecarsAbsent(input.staged)
  await input.assertQuiescent()
  const unrelatedTemporaryFiles = await recoverInterruptedInstall(input.target)
  for (const path of sidecars.map((suffix) => input.target + suffix))
    if (await exists(path)) throw new NativeDatabaseInstallError('TARGET_PRESENT')
  if (await exists(input.target)) {
    const metadata = await lstat(input.target)
    if (metadata.isFile() && metadata.nlink === 1 && (await privateDatabaseDigest(input.target)) === input.stagedSha256)
      return {
        path: input.target,
        sha256: input.stagedSha256,
        state: 'reused',
        unrelatedTemporaryFiles,
      }
    throw new NativeDatabaseInstallError('TARGET_PRESENT')
  }
  await assertDatabaseFilesUnheld([input.staged])
  if ((await privateDatabaseDigest(input.staged)) !== input.stagedSha256)
    throw new NativeDatabaseInstallError('STAGED_CHANGED')
  const temporary = join(directory, `.${basename(input.target)}.installing-${randomUUID()}`)
  await copyFile(input.staged, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
  try {
    await syncDatabasePath(temporary)
    if ((await privateDatabaseDigest(temporary)) !== input.stagedSha256)
      throw new NativeDatabaseInstallError('INSTALL_UNVERIFIED')
    const ownership = await lstat(temporary)
    await input.recordOwnership?.({
      device: ownership.dev,
      inode: ownership.ino,
    })
    await input.assertQuiescent()
    const publishing = await lstat(temporary)
    if (publishing.dev !== ownership.dev || publishing.ino !== ownership.ino || publishing.nlink !== 1)
      throw new NativeDatabaseInstallError('INSTALL_UNVERIFIED')
    for (const path of sidecars.map((suffix) => input.target + suffix))
      if (await exists(path)) throw new NativeDatabaseInstallError('TARGET_PRESENT')
    try {
      await link(temporary, input.target)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new NativeDatabaseInstallError('TARGET_PRESENT')
      throw error
    }
  } finally {
    await unlink(temporary)
  }
  await syncDatabasePath(directory, true)
  if ((await privateDatabaseDigest(input.target)) !== input.stagedSha256)
    throw new NativeDatabaseInstallError('INSTALL_UNVERIFIED')
  await assertDatabaseSidecarsAbsent(input.target)
  return {
    path: input.target,
    sha256: input.stagedSha256,
    state: 'installed',
    unrelatedTemporaryFiles,
  }
}

async function recoverInterruptedInstall(target: string): Promise<number> {
  const directory = dirname(target)
  const prefix = `.${basename(target)}.installing-`
  let unrelated = 0
  const installed = (await exists(target)) ? await lstat(target) : undefined
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue
    const temporary = await lstat(join(directory, name))
    if (
      installed &&
      temporary.isFile() &&
      temporary.dev === installed.dev &&
      temporary.ino === installed.ino &&
      temporary.uid === process.getuid?.()
    ) {
      await unlink(join(directory, name))
      continue
    }
    unrelated++
  }
  if (installed) await syncDatabasePath(directory, true)
  return unrelated
}

export async function retireNativeDatabase(input: {
  readonly target: string
  readonly assertQuiescent: () => Promise<void>
  readonly allowGroupWritableDirectory?: boolean
  readonly retireId?: string
  readonly retirementDirectory?: string
}): Promise<{
  readonly retired: readonly { readonly from: string; readonly to: string }[]
}> {
  if (
    !isAbsolute(input.target) ||
    !basename(input.target).endsWith('.db') ||
    (input.retireId !== undefined && !/^[a-z0-9-]{8,64}$/.test(input.retireId))
  )
    throw new NativeDatabaseInstallError('INVALID_INPUT')
  const directory = dirname(input.target)
  await assertCanonicalDirectory(directory, input.allowGroupWritableDirectory === true)
  if (input.retirementDirectory !== undefined) {
    if (input.retireId === undefined) throw new NativeDatabaseInstallError('INVALID_INPUT')
    return retireRecordedNativeFiles({
      target: input.target,
      retireId: input.retireId,
      directory: input.retirementDirectory,
      assertQuiescent: input.assertQuiescent,
    })
  }
  const paths = [input.target, ...sidecars.map((suffix) => input.target + suffix)]
  const present: string[] = []
  for (const path of paths) if (await exists(path)) present.push(path)
  if (!present.length) return { retired: [] }
  for (const path of present) {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.())
      throw new NativeDatabaseInstallError('TARGET_CHANGED')
  }
  await input.assertQuiescent()
  const holders = spawnSync('/usr/sbin/lsof', ['-t', '--', ...present], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (holders.error || holders.signal || holders.status !== 1 || holders.stdout.trim() || holders.stderr.trim())
    throw new NativeDatabaseInstallError('TARGET_CHANGED')
  const suffix = `.retired-${input.retireId ?? randomUUID()}`
  for (const path of present) if (await exists(path + suffix)) throw new NativeDatabaseInstallError('TARGET_CHANGED')
  const retired: { from: string; to: string }[] = []
  for (const path of present) {
    const to = path + suffix
    await rename(path, to)
    retired.push({ from: path, to })
  }
  await syncDatabasePath(directory, true)
  return { retired }
}
