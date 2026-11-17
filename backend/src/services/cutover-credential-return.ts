import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { restoreOpenAiCopyFromNative } from './openai-native-rollback'
import { publishOpenAiRollback } from './openai-rollback-publication'
import { rollbackClaudeTransfer } from './claude-transfer-rollback'
import { resumeClaudeRollback } from './claude-transfer-resume'
import { readPrivateTransferFile } from './claude-transfer-stage'

export async function returnCutoverCredentials(input: {
  readonly openai: {
    readonly restore: Parameters<typeof restoreOpenAiCopyFromNative>[0]
    readonly legacyTarget: string
  }
  readonly claude: Parameters<typeof rollbackClaudeTransfer>[0]
}) {
  await input.openai.restore.assertQuiescent()
  await input.claude.assertQuiescent()
  const restored = await restoreOpenAiCopyFromNative(input.openai.restore)
  const snapshot = await readPrivateTransferFile(
    join(input.openai.restore.copy.root, `native-openai-${restored.nativeDatabaseSha256}.json`),
  )
  await publishOpenAiRollback({
    copyRoot: input.openai.restore.copy.root,
    target: input.openai.legacyTarget,
    originalSha256: input.openai.restore.copy.sourceSha256,
    nativeSha256: createHash('sha256').update(snapshot).digest('hex'),
    assertQuiescent: input.openai.restore.assertQuiescent,
  })
  let resume = false
  try {
    await lstat(join(input.claude.stagingDirectory, 'rollback-intent.json'))
    resume = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (resume) await resumeClaudeRollback(input.claude)
  else await rollbackClaudeTransfer(input.claude)
  await input.openai.restore.assertQuiescent()
  await input.claude.assertQuiescent()
  return {
    phase: 'both-provider-credentials-returned-services-stopped' as const,
  }
}
