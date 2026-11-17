import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { durableTransferText } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { readStoppedOpenAiCredentials } from './openai-native-snapshot'
import { restoreOpenAiStoreCopy } from './openai-rollback-copy'

export class OpenAiNativeRollbackError extends Error {
  constructor(readonly code: 'INVALID_COPY' | 'DATABASE_CHANGED' | 'SNAPSHOT_CHANGED' | 'NATIVE_ROLLBACK_FAILED') {
    super(code)
    this.name = 'OpenAiNativeRollbackError'
  }
}

export async function restoreOpenAiCopyFromNative(input: {
  readonly native: {
    readonly root: string
    readonly database: string
    readonly sha256: string
  }
  readonly copy: {
    readonly root: string
    readonly sourceFile: string
    readonly sourceSha256: string
  }
  readonly passphrase: string
  readonly assertQuiescent: () => Promise<void>
}) {
  try {
    const { copy, native } = input
    const root = await lstat(copy.root)
    if (
      !isAbsolute(copy.root) ||
      (await realpath(copy.root)) !== copy.root ||
      !root.isDirectory() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 ||
      dirname(copy.sourceFile) !== copy.root ||
      !/^[a-f0-9]{64}$/.test(copy.sourceSha256)
    )
      throw new OpenAiNativeRollbackError('INVALID_COPY')
    const snapshot = await readStoppedOpenAiCredentials({
      ...native,
      assertQuiescent: input.assertQuiescent,
    })
    const release = await acquireClaudeDatabaseLock(`${native.database}.openai-import`)
    try {
      const assertCurrent = async () => {
        await input.assertQuiescent()
        const currentRoot = await lstat(copy.root)
        if (
          (await realpath(copy.root)) !== copy.root ||
          !currentRoot.isDirectory() ||
          currentRoot.uid !== process.getuid?.() ||
          (currentRoot.mode & 0o077) !== 0 ||
          currentRoot.dev !== root.dev ||
          currentRoot.ino !== root.ino
        )
          throw new OpenAiNativeRollbackError('INVALID_COPY')
        await assertDatabaseSidecarsAbsent(native.database)
        if (
          (await realpath(native.database)) !== native.database ||
          (await privateDatabaseDigest(native.database)) !== native.sha256
        )
          throw new OpenAiNativeRollbackError('DATABASE_CHANGED')
      }
      await assertCurrent()
      const text = JSON.stringify({
        version: 1,
        credentials: snapshot.credentials,
        health: snapshot.health,
      })
      const nativeSnapshotFile = join(copy.root, `native-openai-${snapshot.databaseSha256}.json`)
      if (nativeSnapshotFile === copy.sourceFile || copy.sourceFile === native.database)
        throw new OpenAiNativeRollbackError('INVALID_COPY')
      let existing: string | undefined
      try {
        existing = await readPrivateTransferFile(nativeSnapshotFile)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (existing === undefined) {
        const pending = `${nativeSnapshotFile}.pending-${randomUUID()}`
        await durableTransferText(pending, text)
        await assertCurrent()
        await rename(pending, nativeSnapshotFile)
      } else if (existing !== text) {
        throw new OpenAiNativeRollbackError('SNAPSHOT_CHANGED')
      }
      await syncDatabasePath(nativeSnapshotFile)
      await syncDatabasePath(copy.root, true)
      const result = await restoreOpenAiStoreCopy({
        ...copy,
        nativeSnapshotFile,
        nativeSha256: createHash('sha256').update(text).digest('hex'),
        passphrase: input.passphrase,
        assertQuiescent: assertCurrent,
      })
      await assertCurrent()
      return {
        ...result,
        nativeDatabaseSha256: snapshot.databaseSha256,
        credentialCount: snapshot.credentials.length,
      }
    } finally {
      await release()
    }
  } catch (error) {
    throw error instanceof OpenAiNativeRollbackError ? error : new OpenAiNativeRollbackError('NATIVE_ROLLBACK_FAILED')
  }
}
