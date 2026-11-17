import { constants } from 'node:fs'
import { chmod, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { syncDatabasePath } from './claude-database-files'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { z } from 'zod'

export class ConfigFileSwapError extends Error {
  constructor(readonly code: 'INVALID_SCOPE' | 'SOURCE_CHANGED' | 'ARCHIVE_CONFLICT' | 'SWAP_UNVERIFIED') {
    super(code)
    this.name = 'ConfigFileSwapError'
  }
}

type Scope = {
  readonly target: string
  readonly originalSha256: string
  readonly archiveDirectory: string
  readonly assertQuiescent: () => Promise<void>
  readonly allowGroupWritableDirectory?: boolean
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

async function originalMode(archivePath: string) {
  return z
    .object({ mode: z.number().int().min(0).max(0o777) })
    .strict()
    .parse(JSON.parse(await readPrivateTransferFile(archivePath + '.mode.json'))).mode
}

async function preserveMode(archivePath: string, mode: number) {
  try {
    await durableTransferRecord(archivePath + '.mode.json', { mode })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    if ((await originalMode(archivePath)) !== mode) throw new ConfigFileSwapError('SOURCE_CHANGED')
  }
  await syncDatabasePath(archivePath + '.mode.json')
  await syncDatabasePath(dirname(archivePath), true)
}

async function assertDirectory(path: string, allowGroupWritable: boolean) {
  const metadata = await lstat(path)
  if (
    (await realpath(path)) !== path ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    metadata.mode & (allowGroupWritable ? 0o002 : 0o022)
  )
    throw new ConfigFileSwapError('INVALID_SCOPE')
}

async function readTarget(target: string) {
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || metadata.mode & 0o002)
    throw new ConfigFileSwapError('INVALID_SCOPE')
  const bytes = await readFile(target)
  return { bytes, sha256: sha256(bytes), mode: metadata.mode & 0o777 }
}

async function validateScope(input: Scope) {
  if (
    !isAbsolute(input.target) ||
    !isAbsolute(input.archiveDirectory) ||
    !/^[a-f0-9]{64}$/.test(input.originalSha256) ||
    dirname(input.archiveDirectory) === dirname(input.target)
  )
    throw new ConfigFileSwapError('INVALID_SCOPE')
  await assertDirectory(dirname(input.target), input.allowGroupWritableDirectory === true)
  await assertDirectory(input.archiveDirectory, false)
  const archive = await lstat(input.archiveDirectory)
  if (archive.mode & 0o077) throw new ConfigFileSwapError('INVALID_SCOPE')
  return join(input.archiveDirectory, `${basename(input.target)}.${input.originalSha256}.original`)
}

async function writeReplacement(target: string, bytes: Buffer | string, mode: number) {
  const temporary = join(dirname(target), `.${basename(target)}.swap-${randomUUID()}`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary)
    throw error
  }
  await syncDatabasePath(dirname(target), true)
}

async function archiveOriginal(archivePath: string, bytes: Buffer, expected: string) {
  try {
    const existing = await readFile(archivePath)
    if (sha256(existing) !== expected) throw new ConfigFileSwapError('ARCHIVE_CONFLICT')
    return
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const file = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDatabasePath(dirname(archivePath), true)
  if (sha256(await readFile(archivePath)) !== expected) throw new ConfigFileSwapError('SWAP_UNVERIFIED')
}

export async function applyConfigCandidate(
  input: Scope & {
    readonly candidate: string
    readonly candidateSha256: string
  },
): Promise<{
  readonly state: 'applied' | 'reused'
  readonly archive: string
  readonly mode: number
}> {
  if (sha256(input.candidate) !== input.candidateSha256 || input.candidateSha256 === input.originalSha256)
    throw new ConfigFileSwapError('INVALID_SCOPE')
  const archivePath = await validateScope(input)
  await input.assertQuiescent()
  const current = await readTarget(input.target)
  if (current.sha256 === input.candidateSha256) {
    if ((await originalMode(archivePath)) !== current.mode) throw new ConfigFileSwapError('SOURCE_CHANGED')
    if (sha256(await readFile(archivePath)) !== input.originalSha256) throw new ConfigFileSwapError('ARCHIVE_CONFLICT')
    return { state: 'reused', archive: archivePath, mode: current.mode }
  }
  if (current.sha256 !== input.originalSha256) throw new ConfigFileSwapError('SOURCE_CHANGED')
  await archiveOriginal(archivePath, current.bytes, input.originalSha256)
  await preserveMode(archivePath, current.mode)
  await input.assertQuiescent()
  const pinned = await readTarget(input.target)
  if (pinned.sha256 !== input.originalSha256 || pinned.mode !== current.mode)
    throw new ConfigFileSwapError('SOURCE_CHANGED')
  await writeReplacement(input.target, input.candidate, current.mode)
  const after = await readTarget(input.target)
  if (after.sha256 !== input.candidateSha256 || after.mode !== current.mode)
    throw new ConfigFileSwapError('SWAP_UNVERIFIED')
  return { state: 'applied', archive: archivePath, mode: current.mode }
}

export async function restoreConfigOriginal(
  input: Scope & { readonly candidateSha256: string },
): Promise<{ readonly state: 'restored' | 'already-original' }> {
  const archivePath = await validateScope(input)
  await input.assertQuiescent()
  const current = await readTarget(input.target)
  if (current.sha256 === input.originalSha256) {
    try {
      if ((await originalMode(archivePath)) !== current.mode) throw new ConfigFileSwapError('SOURCE_CHANGED')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    return { state: 'already-original' }
  }
  if (current.sha256 !== input.candidateSha256) throw new ConfigFileSwapError('SOURCE_CHANGED')
  const mode = await originalMode(archivePath)
  if (current.mode !== mode) throw new ConfigFileSwapError('SOURCE_CHANGED')
  const original = await readFile(archivePath)
  if (sha256(original) !== input.originalSha256) throw new ConfigFileSwapError('ARCHIVE_CONFLICT')
  await input.assertQuiescent()
  const latest = await readTarget(input.target)
  if (latest.sha256 !== input.candidateSha256 || latest.mode !== current.mode)
    throw new ConfigFileSwapError('SOURCE_CHANGED')
  await writeReplacement(input.target, original, mode)
  const after = await readTarget(input.target)
  if (after.sha256 !== input.originalSha256 || after.mode !== current.mode)
    throw new ConfigFileSwapError('SWAP_UNVERIFIED')
  return { state: 'restored' }
}
