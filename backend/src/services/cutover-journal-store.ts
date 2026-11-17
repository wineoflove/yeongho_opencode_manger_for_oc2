import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import type { CutoverJournal } from './cutover-step-runner'
import { syncDatabasePath } from './claude-database-files'
import { CutoverPublicationUncertainError } from './cutover-publication-error'

const recordSchema = z
  .object({
    sequence: z.number().int().positive(),
    previous: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    state: z.unknown(),
  })
  .strict()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export function encodeCutoverJournalRecord(sequence: number, previous: string | null, state: CutoverJournal) {
  const record = { sequence, previous, state }
  const text = JSON.stringify(record)
  return {
    record,
    text,
    sha256: hash(text),
    filename: `${String(sequence).padStart(6, '0')}.json`,
  }
}

export class CutoverJournalStoreError extends Error {
  constructor(readonly code: 'INVALID_DIRECTORY' | 'INVALID_CHAIN' | 'WRITE_REJECTED' | 'CLOSED') {
    super(code)
    this.name = 'CutoverJournalStoreError'
  }
}

export async function openCutoverJournal(directory: string) {
  const identity = await lstat(directory)
  const assertDirectory = async () => {
    const current = await lstat(directory)
    if (
      !isAbsolute(directory) ||
      (await realpath(directory)) !== directory ||
      !current.isDirectory() ||
      current.uid !== process.getuid?.() ||
      current.mode & 0o077 ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev
    )
      throw new CutoverJournalStoreError('INVALID_DIRECTORY')
  }
  await assertDirectory()
  const release = await acquireClaudeDatabaseLock(directory)
  let sequence = 0
  let previous: string | null = null
  let latest: unknown
  try {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (/^\.pending-record-[a-f0-9-]{36}\.json$/.test(name)) continue
      if (name !== `${String(sequence + 1).padStart(6, '0')}.json`) throw new CutoverJournalStoreError('INVALID_CHAIN')
      const text = await readPrivateTransferFile(join(directory, name))
      const record = recordSchema.parse(JSON.parse(text))
      if (record.sequence !== sequence + 1 || record.previous !== previous)
        throw new CutoverJournalStoreError('INVALID_CHAIN')
      sequence = record.sequence
      previous = hash(text)
      latest = record.state
    }
  } catch {
    await release()
    throw new CutoverJournalStoreError('INVALID_CHAIN')
  }
  let closed = false
  let writing = false
  let failed = false
  return {
    latest: () => latest,
    persist: async (state: CutoverJournal) => {
      if (closed) throw new CutoverJournalStoreError('CLOSED')
      if (writing || failed) throw new CutoverJournalStoreError('WRITE_REJECTED')
      writing = true
      let published = false
      try {
        await assertDirectory()
        const { record, text, filename } = encodeCutoverJournalRecord(sequence + 1, previous, state)
        const pending = join(directory, `.pending-record-${randomUUID()}.json`)
        const target = join(directory, filename)
        await durableTransferRecord(pending, record)
        await assertDirectory()
        try {
          await lstat(target)
          failed = true
          throw new CutoverPublicationUncertainError()
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        await rename(pending, target)
        published = true
        await syncDatabasePath(directory, true)
        sequence = record.sequence
        previous = hash(text)
        latest = structuredClone(state)
      } catch (error) {
        if (published || error instanceof CutoverPublicationUncertainError) {
          failed = true
          throw new CutoverPublicationUncertainError()
        }
        throw new CutoverJournalStoreError('WRITE_REJECTED')
      } finally {
        writing = false
      }
    },
    close: async () => {
      if (closed) return
      if (writing) throw new CutoverJournalStoreError('WRITE_REJECTED')
      await release()
      closed = true
    },
  }
}
