import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { copyFile, lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import {
  ClaudeDatabaseRestoreError,
  privateDatabaseDigest as privateDigest,
  assertDatabaseSidecarsAbsent as assertSidecarsAbsent,
  syncDatabasePath as syncPath,
} from './claude-database-files'
export { ClaudeDatabaseRestoreError } from './claude-database-files'

const databaseSchema = z.object({
  name: z.enum(['manager', 'opencode']),
  backup: z.string().refine(isAbsolute),
  target: z.string().refine(isAbsolute),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
})

type RestoreDatabase = z.infer<typeof databaseSchema>
export type ClaudeDatabaseRestoreInput = {
  readonly directory: string
  readonly databases: readonly RestoreDatabase[]
  readonly assertQuiescent: () => Promise<void>
  readonly verifyDatabase: (path: string) => Promise<void>
}

async function validateRestoreInput(input: ClaudeDatabaseRestoreInput): Promise<RestoreDatabase[]> {
  const parsed = z.array(databaseSchema).length(2).safeParse(input.databases)
  if (!parsed.success || !isAbsolute(input.directory)) throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  const databases = parsed.data
  if (
    new Set(databases.map((entry) => entry.name)).size !== 2 ||
    new Set(databases.flatMap((entry) => [entry.backup, entry.target])).size !== 4
  )
    throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  for (const path of [input.directory, ...databases.flatMap((entry) => [entry.backup, entry.target])]) {
    if ((await realpath(dirname(path))) !== dirname(path)) throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  }
  const device = (await lstat(dirname(input.directory))).dev
  for (const entry of databases) {
    if ((await lstat(dirname(entry.target))).dev !== device) throw new ClaudeDatabaseRestoreError('FILESYSTEM_MISMATCH')
  }
  return databases
}

export async function restoreClaudeDatabases(input: ClaudeDatabaseRestoreInput) {
  const databases = await validateRestoreInput(input)
  await input.assertQuiescent()
  const release = await acquireClaudeDatabaseLock(input.directory)
  let owned = false
  const restored: string[] = []
  try {
    await mkdir(input.directory, { mode: 0o700 })
    owned = true
    await durableTransferRecord(join(input.directory, 'intent.json'), {
      version: 1,
      databases,
    })
    for (const entry of databases) {
      await assertSidecarsAbsent(entry.target)
      await assertSidecarsAbsent(entry.backup)
      if (
        (await privateDigest(entry.target)) !== entry.targetSha256 ||
        (await privateDigest(entry.backup)) !== entry.backupSha256
      )
        throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      const candidate = join(input.directory, `${entry.name}.candidate.db`)
      await copyFile(entry.backup, candidate, constants.COPYFILE_EXCL)
      await input.verifyDatabase(candidate)
      await assertSidecarsAbsent(candidate)
      if ((await privateDigest(candidate)) !== entry.backupSha256) throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      await syncPath(candidate)
      const archive = join(input.directory, `${entry.name}.before.db`)
      await copyFile(entry.target, archive, constants.COPYFILE_EXCL)
      if ((await privateDigest(archive)) !== entry.targetSha256) throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      await syncPath(archive)
    }
    await durableTransferRecord(join(input.directory, 'prepared.json'), {
      phase: 'prepared',
      restored,
    })
    for (const entry of databases) {
      await input.assertQuiescent()
      await assertSidecarsAbsent(entry.target)
      const candidate = join(input.directory, `${entry.name}.candidate.db`)
      if (
        (await privateDigest(entry.target)) !== entry.targetSha256 ||
        (await privateDigest(candidate)) !== entry.backupSha256
      )
        throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      await assertSidecarsAbsent(candidate)
      await rename(candidate, entry.target)
      restored.push(entry.name)
      await syncPath(dirname(entry.target), true)
      await durableTransferRecord(join(input.directory, `${entry.name}.restored.json`), { restored: [...restored] })
    }
    await durableTransferRecord(join(input.directory, 'complete.json'), {
      phase: 'restored',
      restored,
      servicesRestarted: false,
    })
    return { restored, servicesRestarted: false }
  } catch (error) {
    if (owned)
      await durableTransferRecord(join(input.directory, 'failed.json'), {
        phase: 'failed',
        restored,
        code: error instanceof ClaudeDatabaseRestoreError ? error.code : 'RESTORE_FAILED',
        servicesRestarted: false,
      })
    throw error instanceof ClaudeDatabaseRestoreError ? error : new ClaudeDatabaseRestoreError('RESTORE_FAILED')
  } finally {
    await release()
  }
}

export async function resumeClaudeDatabaseRestore(input: ClaudeDatabaseRestoreInput) {
  const databases = await validateRestoreInput(input)
  const directory = await lstat(input.directory)
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(input.directory)) !== input.directory
  )
    throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
  await input.assertQuiescent()
  const release = await acquireClaudeDatabaseLock(input.directory)
  const replaced: string[] = []
  const attempt = randomUUID()
  try {
    const ledger = z
      .object({
        version: z.literal(1),
        databases: z.array(databaseSchema).length(2),
      })
      .parse(JSON.parse(await readPrivateTransferFile(join(input.directory, 'intent.json'))))
    if (
      !isDeepStrictEqual(ledger.databases, databases) ||
      new Set(ledger.databases.map((entry) => entry.name)).size !== 2
    )
      throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
    const prepared = z
      .object({ phase: z.literal('prepared') })
      .safeParse(JSON.parse(await readPrivateTransferFile(join(input.directory, 'prepared.json'))))
    if (!prepared.success) throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
    const pending = []
    for (const entry of ledger.databases) {
      if ((await realpath(dirname(entry.target))) !== dirname(entry.target))
        throw new ClaudeDatabaseRestoreError('INVALID_INPUT')
      await assertSidecarsAbsent(entry.target)
      if ((await privateDigest(join(input.directory, `${entry.name}.before.db`))) !== entry.targetSha256)
        throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      const current = await privateDigest(entry.target)
      if (current === entry.backupSha256) {
        await input.verifyDatabase(entry.target)
        await assertSidecarsAbsent(entry.target)
        if ((await privateDigest(entry.target)) !== entry.backupSha256)
          throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
        continue
      }
      if (current !== entry.targetSha256) throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      const candidate = join(input.directory, `${entry.name}.candidate.db`)
      await assertSidecarsAbsent(candidate)
      await input.verifyDatabase(candidate)
      await assertSidecarsAbsent(candidate)
      if ((await privateDigest(candidate)) !== entry.backupSha256) throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      pending.push(entry)
    }
    for (const entry of pending) {
      await input.assertQuiescent()
      await assertSidecarsAbsent(entry.target)
      const candidate = join(input.directory, `${entry.name}.candidate.db`)
      if (
        (await privateDigest(entry.target)) !== entry.targetSha256 ||
        (await privateDigest(candidate)) !== entry.backupSha256
      )
        throw new ClaudeDatabaseRestoreError('FILE_CHANGED')
      await assertSidecarsAbsent(candidate)
      await rename(candidate, entry.target)
      replaced.push(entry.name)
      await syncPath(dirname(entry.target), true)
      await durableTransferRecord(join(input.directory, `resume-${attempt}-${entry.name}.json`), {
        replaced: [...replaced],
      })
    }
    if (pending.length)
      await durableTransferRecord(join(input.directory, `resume-${attempt}-complete.json`), {
        phase: 'restored',
        replaced,
        servicesRestarted: false,
      })
    return {
      restored: ledger.databases.map((entry) => entry.name),
      replaced,
      servicesRestarted: false,
    }
  } catch (error) {
    await durableTransferRecord(join(input.directory, `resume-${attempt}-failed.json`), {
      phase: 'failed',
      replaced,
      servicesRestarted: false,
      code: error instanceof ClaudeDatabaseRestoreError ? error.code : 'RESTORE_FAILED',
    })
    throw error instanceof ClaudeDatabaseRestoreError ? error : new ClaudeDatabaseRestoreError('RESTORE_FAILED')
  } finally {
    await release()
  }
}
