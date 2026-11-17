import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { syncDatabasePath } from './claude-database-files'
import { durableTransferText, durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { decodeLegacyOpenAiStore, encodeLegacyOpenAiStore } from './legacy-openai-store'
import { prepareOpenAiRollbackCandidate } from './openai-rollback-candidate'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const intentSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal('rollback-copy-intent'),
    sourceFile: z.string(),
    nativeSnapshotFile: z.string(),
    sourceSha256: shaSchema,
    nativeSha256: shaSchema,
    candidateSha256: shaSchema,
  })
  .strict()

export class OpenAiRollbackCopyError extends Error {
  constructor(readonly code: 'INVALID_SCOPE' | 'INPUT_CHANGED' | 'JOURNAL_INVALID' | 'ROLLBACK_COPY_FAILED') {
    super(code)
    this.name = 'OpenAiRollbackCopyError'
  }
}

type RollbackCopyInput = {
  readonly root: string
  readonly sourceFile: string
  readonly nativeSnapshotFile: string
  readonly sourceSha256: string
  readonly nativeSha256: string
  readonly passphrase: string
  readonly assertQuiescent: () => Promise<void>
}

async function assertPrivateDirectory(path: string) {
  const stat = await lstat(path)
  if (
    !isAbsolute(path) ||
    (await realpath(path)) !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new OpenAiRollbackCopyError('INVALID_SCOPE')
  return `${stat.dev}:${stat.ino}`
}

export async function restoreOpenAiStoreCopy(input: RollbackCopyInput) {
  try {
    if (
      !shaSchema.safeParse(input.sourceSha256).success ||
      !shaSchema.safeParse(input.nativeSha256).success ||
      !input.passphrase ||
      input.sourceFile === input.nativeSnapshotFile
    )
      throw new OpenAiRollbackCopyError('INVALID_SCOPE')
    const rootIdentity = await assertPrivateDirectory(input.root)
    for (const path of [input.sourceFile, input.nativeSnapshotFile]) {
      const local = relative(input.root, path)
      if (
        !isAbsolute(path) ||
        dirname(path) !== input.root ||
        !local ||
        local.startsWith('..') ||
        isAbsolute(local) ||
        (await realpath(path)) !== path
      )
        throw new OpenAiRollbackCopyError('INVALID_SCOPE')
      await assertPrivateDirectory(dirname(path))
    }
    const release = await acquireClaudeDatabaseLock(`${input.sourceFile}.openai-rollback`)
    try {
      await input.assertQuiescent()
      if ((await assertPrivateDirectory(input.root)) !== rootIdentity)
        throw new OpenAiRollbackCopyError('INPUT_CHANGED')
      const nativeText = await readPrivateTransferFile(input.nativeSnapshotFile)
      if (hash(nativeText) !== input.nativeSha256) throw new OpenAiRollbackCopyError('INPUT_CHANGED')
      const journal = join(input.root, 'openai-rollback-journal')
      const intentPath = join(journal, 'intent.json')
      let intentText: string | undefined
      try {
        await assertPrivateDirectory(journal)
        intentText = await readPrivateTransferFile(intentPath)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (intentText === undefined) {
        const original = await readPrivateTransferFile(input.sourceFile)
        if (hash(original) !== input.sourceSha256) throw new OpenAiRollbackCopyError('INPUT_CHANGED')
        const candidate = prepareOpenAiRollbackCandidate(
          decodeLegacyOpenAiStore(original, input.passphrase),
          JSON.parse(nativeText),
        )
        const encrypted = encodeLegacyOpenAiStore(candidate.store, input.passphrase)
        const pendingJournal = `${journal}.pending-${randomUUID()}`
        await mkdir(pendingJournal, { mode: 0o700 })
        await durableTransferText(join(pendingJournal, 'original.json'), original)
        await durableTransferText(join(pendingJournal, 'candidate.json'), encrypted)
        const intent = {
          version: 1,
          phase: 'rollback-copy-intent',
          sourceFile: input.sourceFile,
          nativeSnapshotFile: input.nativeSnapshotFile,
          sourceSha256: input.sourceSha256,
          nativeSha256: input.nativeSha256,
          candidateSha256: hash(encrypted),
        }
        await durableTransferRecord(join(pendingJournal, 'intent.json'), intent)
        if ((await assertPrivateDirectory(input.root)) !== rootIdentity)
          throw new OpenAiRollbackCopyError('INPUT_CHANGED')
        await rename(pendingJournal, journal)
        await syncDatabasePath(input.root, true)
        intentText = JSON.stringify(intent)
      }
      const journalIdentity = await assertPrivateDirectory(journal)
      const intent = intentSchema.parse(JSON.parse(intentText))
      if (
        intent.sourceFile !== input.sourceFile ||
        intent.nativeSnapshotFile !== input.nativeSnapshotFile ||
        intent.sourceSha256 !== input.sourceSha256 ||
        intent.nativeSha256 !== input.nativeSha256
      )
        throw new OpenAiRollbackCopyError('JOURNAL_INVALID')
      const original = await readPrivateTransferFile(join(journal, 'original.json'))
      const encrypted = await readPrivateTransferFile(join(journal, 'candidate.json'))
      if (hash(original) !== input.sourceSha256 || hash(encrypted) !== intent.candidateSha256)
        throw new OpenAiRollbackCopyError('JOURNAL_INVALID')
      const expected = prepareOpenAiRollbackCandidate(
        decodeLegacyOpenAiStore(original, input.passphrase),
        JSON.parse(nativeText),
      )
      if (!isDeepStrictEqual(decodeLegacyOpenAiStore(encrypted, input.passphrase), expected.store))
        throw new OpenAiRollbackCopyError('JOURNAL_INVALID')
      await input.assertQuiescent()
      if (
        (await assertPrivateDirectory(input.root)) !== rootIdentity ||
        (await assertPrivateDirectory(journal)) !== journalIdentity ||
        (await readPrivateTransferFile(intentPath)) !== intentText ||
        (await readPrivateTransferFile(input.nativeSnapshotFile)) !== nativeText
      )
        throw new OpenAiRollbackCopyError('INPUT_CHANGED')
      const current = await readPrivateTransferFile(input.sourceFile)
      const reused = hash(current) === intent.candidateSha256
      if (!reused) {
        if (hash(current) !== input.sourceSha256) throw new OpenAiRollbackCopyError('INPUT_CHANGED')
        const pending = `${input.sourceFile}.rollback-pending-${randomUUID()}`
        await durableTransferText(pending, encrypted)
        if (
          (await assertPrivateDirectory(input.root)) !== rootIdentity ||
          (await realpath(input.sourceFile)) !== input.sourceFile ||
          hash(await readPrivateTransferFile(input.sourceFile)) !== input.sourceSha256 ||
          (await readPrivateTransferFile(input.nativeSnapshotFile)) !== nativeText
        )
          throw new OpenAiRollbackCopyError('INPUT_CHANGED')
        await rename(pending, input.sourceFile)
      }
      await syncDatabasePath(input.sourceFile)
      await syncDatabasePath(dirname(input.sourceFile), true)
      if ((await readPrivateTransferFile(input.sourceFile)) !== encrypted)
        throw new OpenAiRollbackCopyError('INPUT_CHANGED')
      return {
        phase: 'rollback-copy-written-services-stopped',
        reused,
        refreshOwnershipTransferred: false,
        executable: false,
      }
    } finally {
      await release()
    }
  } catch (error) {
    throw error instanceof OpenAiRollbackCopyError ? error : new OpenAiRollbackCopyError('ROLLBACK_COPY_FAILED')
  }
}
