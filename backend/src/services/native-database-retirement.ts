import { lstat, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { syncDatabasePath } from './claude-database-files'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { assertDatabaseFilesUnheld } from './claude-transfer-quiescence'

const metadataSchema = z
  .object({
    device: z.number(),
    inode: z.number(),
    size: z.number(),
    modified: z.number(),
  })
  .strict()
const suffixSchema = z.enum(['', '-wal', '-shm', '-journal'])
const recordSchema = z
  .object({
    target: z.string(),
    retireId: z.string(),
    files: z.array(z.object({ suffix: suffixSchema, identity: metadataSchema }).strict()).min(1),
  })
  .strict()

export class NativeRetirementError extends Error {
  constructor() {
    super('NATIVE_RETIREMENT_UNVERIFIED')
    this.name = 'NativeRetirementError'
  }
}

async function identity(path: string) {
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.()) throw new NativeRetirementError()
    return {
      device: file.dev,
      inode: file.ino,
      size: file.size,
      modified: file.mtimeMs,
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function retireRecordedNativeFiles(input: {
  readonly target: string
  readonly retireId: string
  readonly directory: string
  readonly assertQuiescent: () => Promise<void>
}) {
  const directory = await lstat(input.directory)
  if (
    !isAbsolute(input.directory) ||
    (await realpath(input.directory)) !== input.directory ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new NativeRetirementError()
  const release = await acquireClaudeDatabaseLock(join(input.directory, 'native-retirement'))
  try {
    await input.assertQuiescent()
    const recordPath = join(input.directory, `native-retirement-${input.retireId}.json`)
    let record: z.infer<typeof recordSchema>
    try {
      record = recordSchema.parse(JSON.parse(await readPrivateTransferFile(recordPath)))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const files: z.infer<typeof recordSchema>['files'] = []
      for (const suffix of suffixSchema.options) {
        const current = await identity(input.target + suffix)
        if (await identity(`${input.target}${suffix}.retired-${input.retireId}`)) throw new NativeRetirementError()
        if (current) files.push({ suffix, identity: current })
      }
      if (!files.some((file) => file.suffix === '')) throw new NativeRetirementError()
      record = { target: input.target, retireId: input.retireId, files }
      const pending = join(input.directory, `retirement-${randomUUID()}.pending`)
      await durableTransferRecord(pending, record)
      await rename(pending, recordPath)
      await syncDatabasePath(input.directory, true)
    }
    if (
      record.target !== input.target ||
      record.retireId !== input.retireId ||
      new Set(record.files.map((file) => file.suffix)).size !== record.files.length ||
      !record.files.some((file) => file.suffix === '')
    )
      throw new NativeRetirementError()
    for (const suffix of suffixSchema.options) {
      if (
        !record.files.some((file) => file.suffix === suffix) &&
        ((await identity(input.target + suffix)) ||
          (await identity(`${input.target}${suffix}.retired-${input.retireId}`)))
      )
        throw new NativeRetirementError()
    }
    const retired = []
    for (const file of record.files) {
      await input.assertQuiescent()
      const from = input.target + file.suffix
      const to = `${from}.retired-${input.retireId}`
      const source = await identity(from)
      const destination = await identity(to)
      if (
        (source && destination) ||
        (!source && !destination) ||
        JSON.stringify(source ?? destination) !== JSON.stringify(file.identity)
      )
        throw new NativeRetirementError()
      await assertDatabaseFilesUnheld([source ? from : to])
      if (source) {
        if (JSON.stringify(await identity(from)) !== JSON.stringify(file.identity) || (await identity(to)))
          throw new NativeRetirementError()
        await rename(from, to)
      }
      await syncDatabasePath(to)
      retired.push({ from, to })
    }
    await syncDatabasePath(input.directory, true)
    await syncDatabasePath(dirname(input.target), true)
    return { retired }
  } finally {
    await release()
  }
}
