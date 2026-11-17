import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { syncDatabasePath } from './claude-database-files'
import { decodeLegacyOpenAiStore } from './legacy-openai-store'
import { mapLegacyOpenAiCredentials } from './openai-credential-transfer'
import { planOpenAiRotationTransfer } from './openai-rotation-transfer'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const ledgerSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal('staged-not-activated'),
    sourceFile: z.string(),
    sourceSha256: sha,
    sourceContentSha256: sha,
    credentialCount: z.number().int().min(1).max(20),
    credentialFileSha256: sha,
    rotationFileSha256: sha,
    activeCredentialID: z.string().min(1),
    preserveRateLimits: z.boolean().optional(),
    refreshOwnershipTransferred: z.literal(false),
    executable: z.literal(false),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict()

export class OpenAiCandidateError extends Error {
  constructor(
    readonly code: 'INVALID_STAGE' | 'STAGE_FAILED' | 'SOURCE_CHANGED' | 'CANDIDATE_CHANGED' | 'DURABILITY_UNCONFIRMED',
  ) {
    super(code)
    this.name = 'OpenAiCandidateError'
  }
}

function parseCandidateJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new OpenAiCandidateError('INVALID_STAGE')
  }
}

export async function validateOpenAiTransferCandidate(input: {
  readonly directory: string
  readonly sourceFile: string
  readonly passphrase?: string
  readonly executionBudgetMs: number
  readonly preserveRateLimits?: boolean
  readonly assertQuiescent: () => Promise<void>
}) {
  if (
    ![input.directory, input.sourceFile].every(isAbsolute) ||
    (await realpath(input.directory)) !== input.directory ||
    (await realpath(input.sourceFile)) !== input.sourceFile
  )
    throw new OpenAiCandidateError('INVALID_STAGE')
  const directory = await lstat(input.directory)
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new OpenAiCandidateError('INVALID_STAGE')
  await input.assertQuiescent()
  async function assertNoFailure() {
    try {
      await lstat(join(input.directory, 'failed.json'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    throw new OpenAiCandidateError('STAGE_FAILED')
  }
  await assertNoFailure()
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const ledgerPath = join(input.directory, 'ledger.json')
  const ledgerText = await readPrivateTransferFile(ledgerPath)
  const parsed = ledgerSchema.safeParse(parseCandidateJson(ledgerText))
  if (!parsed.success || parsed.data.sourceFile !== input.sourceFile || parsed.data.recordedAt > Date.now())
    throw new OpenAiCandidateError('INVALID_STAGE')
  const ledger = parsed.data
  if ((ledger.preserveRateLimits ?? false) !== (input.preserveRateLimits ?? false))
    throw new OpenAiCandidateError('INVALID_STAGE')
  const source = await readPrivateTransferFile(input.sourceFile)
  if (
    hash(source) !== ledger.sourceSha256 ||
    (await readPrivateTransferFile(join(input.directory, 'store.original.json'))) !== source
  )
    throw new OpenAiCandidateError('SOURCE_CHANGED')
  const decoded = decodeLegacyOpenAiStore(source, input.passphrase)
  const mapped = mapLegacyOpenAiCredentials(decoded)
  const credentialText = await readPrivateTransferFile(join(input.directory, 'credentials.pending.json'))
  const rotationText = await readPrivateTransferFile(join(input.directory, 'rotation.pending.json'))
  const rotationValue = parseCandidateJson(rotationText)
  const assessed = z.object({ assessedAt: z.number().int().nonnegative() }).safeParse(rotationValue)
  if (!assessed.success || assessed.data.assessedAt > Date.now()) throw new OpenAiCandidateError('INVALID_STAGE')
  const rotation = planOpenAiRotationTransfer(decoded, {
    now: assessed.data.assessedAt,
    executionBudgetMs: input.executionBudgetMs,
    preserveRateLimits: input.preserveRateLimits,
  })
  if (
    hash(credentialText) !== ledger.credentialFileSha256 ||
    hash(rotationText) !== ledger.rotationFileSha256 ||
    mapped.sourceContentSha256 !== ledger.sourceContentSha256 ||
    mapped.credentials.length !== ledger.credentialCount ||
    mapped.activeCredentialID !== ledger.activeCredentialID ||
    !isDeepStrictEqual(parseCandidateJson(credentialText), mapped.credentials) ||
    !isDeepStrictEqual(rotationValue, rotation)
  )
    throw new OpenAiCandidateError('CANDIDATE_CHANGED')
  try {
    await syncDatabasePath(ledgerPath)
    await syncDatabasePath(input.directory, true)
  } catch {
    throw new OpenAiCandidateError('DURABILITY_UNCONFIRMED')
  }
  await input.assertQuiescent()
  await assertNoFailure()
  const after = await lstat(input.directory)
  if (after.dev !== directory.dev || after.ino !== directory.ino) throw new OpenAiCandidateError('INVALID_STAGE')
  if ((await readPrivateTransferFile(input.sourceFile)) !== source) throw new OpenAiCandidateError('SOURCE_CHANGED')
  for (const [name, expected] of [
    ['ledger.json', ledgerText],
    ['store.original.json', source],
    ['credentials.pending.json', credentialText],
    ['rotation.pending.json', rotationText],
  ]) {
    if (!name || expected === undefined || (await readPrivateTransferFile(join(input.directory, name))) !== expected)
      throw new OpenAiCandidateError('CANDIDATE_CHANGED')
  }
  planOpenAiRotationTransfer(decoded, {
    now: Date.now(),
    executionBudgetMs: input.executionBudgetMs,
    preserveRateLimits: input.preserveRateLimits,
  })
  return {
    phase: 'validated-not-activated',
    credentials: mapped.credentials,
    rotation,
    activeCredentialID: mapped.activeCredentialID,
    sourceSha256: ledger.sourceSha256,
    ledgerSha256: hash(ledgerText),
    durabilityReconfirmed: true,
    targetMustStayStopped: true,
    nativeInactiveCreationGuaranteed: false,
    refreshOwnershipTransferred: false,
    executable: false,
  }
}
