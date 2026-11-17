import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { applyConfigCandidate } from './config-file-swap'
import { readPrivateTransferFile } from './claude-transfer-stage'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const intentSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal('rollback-copy-intent'),
    sourceFile: z.string(),
    nativeSnapshotFile: z.string(),
    sourceSha256: sha,
    nativeSha256: sha,
    candidateSha256: sha,
  })
  .strict()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export class OpenAiRollbackPublicationError extends Error {
  constructor() {
    super('OPENAI_ROLLBACK_PUBLICATION_UNVERIFIED')
    this.name = 'OpenAiRollbackPublicationError'
  }
}

export async function publishOpenAiRollback(input: {
  readonly copyRoot: string
  readonly target: string
  readonly originalSha256: string
  readonly nativeSha256: string
  readonly assertQuiescent: () => Promise<void>
}) {
  try {
    if (!isAbsolute(input.copyRoot) || !isAbsolute(input.target)) throw new OpenAiRollbackPublicationError()
    const journal = join(input.copyRoot, 'openai-rollback-journal')
    const intent = intentSchema.parse(JSON.parse(await readPrivateTransferFile(join(journal, 'intent.json'))))
    if (
      intent.sourceSha256 !== input.originalSha256 ||
      intent.nativeSha256 !== input.nativeSha256 ||
      intent.sourceFile === input.target
    )
      throw new OpenAiRollbackPublicationError()
    const original = await readPrivateTransferFile(join(journal, 'original.json'))
    const candidate = await readPrivateTransferFile(join(journal, 'candidate.json'))
    const native = await readPrivateTransferFile(intent.nativeSnapshotFile)
    if (
      hash(original) !== input.originalSha256 ||
      hash(candidate) !== intent.candidateSha256 ||
      hash(native) !== input.nativeSha256 ||
      (await readPrivateTransferFile(intent.sourceFile)) !== candidate
    )
      throw new OpenAiRollbackPublicationError()
    const result = await applyConfigCandidate({
      target: input.target,
      originalSha256: input.originalSha256,
      candidate,
      candidateSha256: intent.candidateSha256,
      archiveDirectory: journal,
      assertQuiescent: async () => {
        await input.assertQuiescent()
        if (
          (await readPrivateTransferFile(join(journal, 'candidate.json'))) !== candidate ||
          hash(await readPrivateTransferFile(intent.nativeSnapshotFile)) !== input.nativeSha256
        )
          throw new OpenAiRollbackPublicationError()
      },
    })
    return {
      phase: 'latest-openai-credentials-published-services-stopped' as const,
      reused: result.state === 'reused',
    }
  } catch {
    throw new OpenAiRollbackPublicationError()
  }
}
