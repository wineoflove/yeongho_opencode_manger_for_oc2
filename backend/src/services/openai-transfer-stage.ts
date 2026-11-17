import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { decodeLegacyOpenAiStore, LegacyOpenAiStoreError } from './legacy-openai-store'
import { mapLegacyOpenAiCredentials, OpenAiTransferPlanError } from './openai-credential-transfer'
import { planOpenAiRotationTransfer, OpenAiRotationTransferError } from './openai-rotation-transfer'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { durableTransferRecord, durableTransferText } from './claude-transfer-activate'
import { OpenAiStagePublicationError, publishOpenAiStageLedger } from './openai-stage-publication'

export class OpenAiTransferStageError extends Error {
  constructor(readonly code: 'INVALID_STAGE' | 'SOURCE_CHANGED' | 'CANDIDATE_CHANGED' | 'STAGING_FAILED') {
    super(code)
    this.name = 'OpenAiTransferStageError'
  }
}

export async function stageOpenAiTransfer(input: {
  readonly sourceFile: string
  readonly directory: string
  readonly passphrase?: string
  readonly executionBudgetMs: number
  readonly preserveRateLimits?: boolean
  readonly assertQuiescent: () => Promise<void>
}) {
  if (
    ![input.sourceFile, input.directory].every(isAbsolute) ||
    (await realpath(input.sourceFile)) !== input.sourceFile ||
    (await realpath(dirname(input.directory))) !== dirname(input.directory)
  )
    throw new OpenAiTransferStageError('INVALID_STAGE')
  const parent = await lstat(dirname(input.directory))
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
    throw new OpenAiTransferStageError('INVALID_STAGE')
  await input.assertQuiescent()
  const source = await readPrivateTransferFile(input.sourceFile)
  const decoded = decodeLegacyOpenAiStore(source, input.passphrase)
  const credentials = mapLegacyOpenAiCredentials(decoded)
  const rotation = planOpenAiRotationTransfer(decoded, {
    now: Date.now(),
    executionBudgetMs: input.executionBudgetMs,
    preserveRateLimits: input.preserveRateLimits,
  })
  await mkdir(input.directory, { mode: 0o700 })
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const credentialText = JSON.stringify(credentials.credentials)
  const rotationText = JSON.stringify(rotation)
  try {
    await durableTransferText(join(input.directory, 'store.original.json'), source)
    await durableTransferText(join(input.directory, 'credentials.pending.json'), credentialText)
    await durableTransferText(join(input.directory, 'rotation.pending.json'), rotationText)
    await input.assertQuiescent()
    if ((await readPrivateTransferFile(input.sourceFile)) !== source)
      throw new OpenAiTransferStageError('SOURCE_CHANGED')
    planOpenAiRotationTransfer(decoded, {
      now: Date.now(),
      executionBudgetMs: input.executionBudgetMs,
      preserveRateLimits: input.preserveRateLimits,
    })
    if (
      (await readPrivateTransferFile(join(input.directory, 'store.original.json'))) !== source ||
      (await readPrivateTransferFile(join(input.directory, 'credentials.pending.json'))) !== credentialText ||
      (await readPrivateTransferFile(join(input.directory, 'rotation.pending.json'))) !== rotationText
    )
      throw new OpenAiTransferStageError('CANDIDATE_CHANGED')
    const ledger = {
      version: 1,
      phase: 'staged-not-activated',
      sourceFile: input.sourceFile,
      sourceSha256: hash(source),
      sourceContentSha256: credentials.sourceContentSha256,
      credentialCount: credentials.credentials.length,
      credentialFileSha256: hash(credentialText),
      rotationFileSha256: hash(rotationText),
      activeCredentialID: credentials.activeCredentialID,
      ...(input.preserveRateLimits ? { preserveRateLimits: true } : {}),
      refreshOwnershipTransferred: false,
      executable: false,
      recordedAt: Date.now(),
    }
    await publishOpenAiStageLedger(input.directory, ledger)
    return ledger
  } catch (error) {
    if (error instanceof OpenAiStagePublicationError) throw error
    const code =
      error instanceof OpenAiTransferStageError ||
      error instanceof LegacyOpenAiStoreError ||
      error instanceof OpenAiTransferPlanError ||
      error instanceof OpenAiRotationTransferError
        ? error.code
        : 'STAGING_FAILED'
    await durableTransferRecord(join(input.directory, 'failed.json'), {
      phase: 'failed',
      code,
      executable: false,
    })
    throw error instanceof Error ? error : new OpenAiTransferStageError('STAGING_FAILED')
  }
}
