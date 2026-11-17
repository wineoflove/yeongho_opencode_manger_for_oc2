import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { syncDatabasePath } from './claude-database-files'
import { restoreClaudeTransfer, ClaudeTransferError } from './claude-proxy-transfer'
import { readPrivateTransferFile, restoreNativeAnthropicAuth } from './claude-transfer-stage'
import { durableTransferRecord, durableTransferText, type ClaudeActivationInput } from './claude-transfer-activate'

const ledgerSchema = z
  .object({
    sourceSha256: z.string(),
    nativeAuthSha256: z.string(),
    nativeAuthMode: z.enum(['synchronize-main', 'preserve-anchor']).default('synchronize-main'),
    entries: z.array(z.object({ proxyFile: z.string().regex(/^legacy-[A-Za-z0-9-]+\.json$/) })),
  })
  .passthrough()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function replaceClaudeCredentialFile(path: string, value: string, expectedHash: string) {
  if (hash(await readPrivateTransferFile(path)) !== expectedHash) throw new ClaudeTransferError('SOURCE_CHANGED')
  const pending = `${path}.claude-rollback-pending`
  try {
    const file = await open(
      pending,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(value)
      await file.sync()
    } finally {
      await file.close()
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    if (hash(await readPrivateTransferFile(pending)) !== hash(value)) throw new ClaudeTransferError('SOURCE_CHANGED')
    const file = await open(pending, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }
  if (hash(await readPrivateTransferFile(path)) !== expectedHash) throw new ClaudeTransferError('SOURCE_CHANGED')
  await rename(pending, path)
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function rollbackClaudeTransfer(input: ClaudeActivationInput & { readonly gateDirectory: string }) {
  if (
    ![
      input.poolFile,
      input.nativeAuthFile,
      input.stagingDirectory,
      input.targetAuthDirectory,
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
    const activation = JSON.parse(
      await readPrivateTransferFile(join(input.stagingDirectory, 'activation-installed.json')),
    )
    if (activation?.phase !== 'files-installed-services-stopped') throw new ClaudeTransferError('INVALID_INPUT')
    const rawLedger = JSON.parse(await readPrivateTransferFile(join(input.stagingDirectory, 'ledger.json')))
    const ledger = ledgerSchema.parse(rawLedger)
    const pool = await readPrivateTransferFile(join(input.stagingDirectory, 'pool.before.json'))
    const auth = await readPrivateTransferFile(join(input.stagingDirectory, 'auth.before.json'))
    if (hash(pool) !== ledger.sourceSha256 || hash(auth) !== ledger.nativeAuthSha256)
      throw new ClaudeTransferError('SOURCE_CHANGED')
    if (
      hash(await readPrivateTransferFile(input.poolFile)) !== ledger.sourceSha256 ||
      hash(await readPrivateTransferFile(input.nativeAuthFile)) !== ledger.nativeAuthSha256
    )
      throw new ClaudeTransferError('SOURCE_CHANGED')
    const names = (await readdir(input.targetAuthDirectory)).filter((name) => name.endsWith('.json')).sort()
    if (JSON.stringify(names) !== JSON.stringify(ledger.entries.map((entry) => entry.proxyFile).sort()))
      throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    const files: Record<string, unknown> = {}
    const hashes: Record<string, string> = {}
    for (const entry of ledger.entries) {
      const text = await readPrivateTransferFile(join(input.targetAuthDirectory, entry.proxyFile))
      files[entry.proxyFile] = JSON.parse(text)
      hashes[entry.proxyFile] = hash(text)
    }
    const restoredPool = restoreClaudeTransfer(pool, rawLedger, files)
    const restoredAuth =
      ledger.nativeAuthMode === 'preserve-anchor' ? auth : await restoreNativeAnthropicAuth(auth, restoredPool)
    await input.assertQuiescent()
    for (const entry of ledger.entries)
      if (
        hash(await readPrivateTransferFile(join(input.targetAuthDirectory, entry.proxyFile))) !==
        hashes[entry.proxyFile]
      )
        throw new ClaudeTransferError('SOURCE_CHANGED')
    for (const [name, text] of [
      ['pool.return.json', JSON.stringify(JSON.parse(restoredPool))],
      ['auth.return.json', restoredAuth],
    ] as const) {
      const path = join(input.stagingDirectory, name)
      try {
        await durableTransferText(path, text)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        if ((await readPrivateTransferFile(path)) !== text) throw new ClaudeTransferError('SOURCE_CHANGED')
      }
    }
    await syncDatabasePath(join(input.stagingDirectory, 'pool.return.json'))
    await syncDatabasePath(join(input.stagingDirectory, 'auth.return.json'))
    await syncDatabasePath(input.stagingDirectory, true)
    await durableTransferRecord(join(input.stagingDirectory, 'rollback-intent.json'), {
      phase: 'rollback-intent',
      poolSha256: hash(restoredPool),
      authSha256: hash(restoredAuth),
      proxyHashes: hashes,
      at: Date.now(),
    })
    await replaceClaudeCredentialFile(input.poolFile, restoredPool, ledger.sourceSha256)
    await durableTransferRecord(join(input.stagingDirectory, 'rollback-pool-written.json'), {
      phase: 'pool-written',
      at: Date.now(),
    })
    await input.assertQuiescent()
    if (ledger.nativeAuthMode === 'synchronize-main')
      await replaceClaudeCredentialFile(input.nativeAuthFile, restoredAuth, ledger.nativeAuthSha256)
    else if (hash(await readPrivateTransferFile(input.nativeAuthFile)) !== ledger.nativeAuthSha256)
      throw new ClaudeTransferError('SOURCE_CHANGED')
    await durableTransferRecord(join(input.stagingDirectory, 'rollback-complete.json'), {
      phase: 'latest-credentials-returned-services-stopped',
      at: Date.now(),
    })
    return { phase: 'latest-credentials-returned-services-stopped' }
  } catch (error) {
    throw error instanceof ClaudeTransferError ? error : new ClaudeTransferError('INVALID_INPUT')
  } finally {
    await rmdir(lock)
  }
}
