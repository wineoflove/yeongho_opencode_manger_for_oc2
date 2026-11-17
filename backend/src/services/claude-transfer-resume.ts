import { lstat, mkdir, rmdir, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ClaudeTransferError, restoreClaudeTransfer } from './claude-proxy-transfer'
import { readPrivateTransferFile, restoreNativeAnthropicAuth } from './claude-transfer-stage'
import { durableTransferRecord, type ClaudeActivationInput } from './claude-transfer-activate'
import { replaceClaudeCredentialFile } from './claude-transfer-rollback'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const intentSchema = z.object({
  phase: z.literal('rollback-intent'),
  poolSha256: digest,
  authSha256: digest,
  proxyHashes: z.record(z.string().regex(/^legacy-[A-Za-z0-9-]+\.json$/), digest),
})
const ledgerSchema = z
  .object({
    sourceSha256: digest,
    nativeAuthSha256: digest,
    nativeAuthMode: z.enum(['synchronize-main', 'preserve-anchor']).default('synchronize-main'),
  })
  .passthrough()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function resumeClaudeRollback(input: ClaudeActivationInput & { readonly gateDirectory: string }) {
  if (
    ![
      input.stagingDirectory,
      input.targetAuthDirectory,
      input.poolFile,
      input.nativeAuthFile,
      input.gateDirectory,
    ].every(isAbsolute)
  )
    throw new ClaudeTransferError('INVALID_INPUT')
  await input.assertQuiescent()
  const lock = `${input.stagingDirectory}.lock`
  await mkdir(lock, { mode: 0o700 })
  try {
    const gate = JSON.parse(await readPrivateTransferFile(join(input.gateDirectory, 'ready.json')))
    if (gate?.version !== 1) throw new ClaudeTransferError('INVALID_INPUT')
    try {
      await lstat(join(input.gateDirectory, 'blocked'))
      throw new ClaudeTransferError('SOURCE_BLOCKED')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const intent = intentSchema.parse(
      JSON.parse(await readPrivateTransferFile(join(input.stagingDirectory, 'rollback-intent.json'))),
    )
    const rawLedger = JSON.parse(await readPrivateTransferFile(join(input.stagingDirectory, 'ledger.json')))
    const ledger = ledgerSchema.parse(rawLedger)
    const beforePool = await readPrivateTransferFile(join(input.stagingDirectory, 'pool.before.json'))
    const beforeAuth = await readPrivateTransferFile(join(input.stagingDirectory, 'auth.before.json'))
    if (hash(beforePool) !== ledger.sourceSha256 || hash(beforeAuth) !== ledger.nativeAuthSha256)
      throw new ClaudeTransferError('SOURCE_CHANGED')
    const names = (await readdir(input.targetAuthDirectory)).filter((name) => name.endsWith('.json')).sort()
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(intent.proxyHashes).sort()))
      throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    const files: Record<string, unknown> = {}
    for (const name of names) {
      const text = await readPrivateTransferFile(join(input.targetAuthDirectory, name))
      if (hash(text) !== intent.proxyHashes[name]) throw new ClaudeTransferError('SOURCE_CHANGED')
      files[name] = JSON.parse(text)
    }
    const pool = await readPrivateTransferFile(join(input.stagingDirectory, 'pool.return.json'))
    const auth = await readPrivateTransferFile(join(input.stagingDirectory, 'auth.return.json'))
    const expectedPool = restoreClaudeTransfer(beforePool, rawLedger, files)
    if (
      hash(pool) !== intent.poolSha256 ||
      pool !== expectedPool ||
      hash(auth) !== intent.authSha256 ||
      auth !==
        (ledger.nativeAuthMode === 'preserve-anchor'
          ? beforeAuth
          : await restoreNativeAnthropicAuth(beforeAuth, expectedPool))
    )
      throw new ClaudeTransferError('SOURCE_CHANGED')
    const updates = [
      {
        file: input.poolFile,
        text: pool,
        before: ledger.sourceSha256,
        after: intent.poolSha256,
      },
      {
        file: input.nativeAuthFile,
        text: auth,
        before: ledger.nativeAuthSha256,
        after: intent.authSha256,
      },
    ]
    for (const entry of updates) {
      const observed = hash(await readPrivateTransferFile(entry.file))
      if (observed !== entry.before && observed !== entry.after) throw new ClaudeTransferError('SOURCE_CHANGED')
    }
    let written = 0
    for (const entry of updates) {
      await input.assertQuiescent()
      for (const [name, digest] of Object.entries(intent.proxyHashes)) {
        if (hash(await readPrivateTransferFile(join(input.targetAuthDirectory, name))) !== digest)
          throw new ClaudeTransferError('SOURCE_CHANGED')
      }
      const observed = hash(await readPrivateTransferFile(entry.file))
      if (observed === entry.after) continue
      if (observed !== entry.before) throw new ClaudeTransferError('SOURCE_CHANGED')
      await replaceClaudeCredentialFile(entry.file, entry.text, entry.before)
      written++
    }
    const completion = join(input.stagingDirectory, 'rollback-complete.json')
    try {
      await durableTransferRecord(completion, {
        phase: 'latest-credentials-returned-services-stopped',
        resumed: true,
        at: Date.now(),
      })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const prior = JSON.parse(await readPrivateTransferFile(completion))
      if (prior?.phase !== 'latest-credentials-returned-services-stopped')
        throw new ClaudeTransferError('INVALID_INPUT')
    }
    return { phase: 'latest-credentials-returned-services-stopped', written }
  } catch (error) {
    throw error instanceof ClaudeTransferError ? error : new ClaudeTransferError('INVALID_INPUT')
  } finally {
    await rmdir(lock)
  }
}
