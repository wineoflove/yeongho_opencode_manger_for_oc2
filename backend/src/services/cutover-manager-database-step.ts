import { lstat } from 'node:fs/promises'
import { installNativeDatabase, retireNativeDatabase } from './native-database-install'
import {
  assertDatabaseSidecarsAbsent,
  privateDatabaseDigest,
  ClaudeDatabaseRestoreError,
} from './claude-database-files'
import type { CutoverStep } from './cutover-step-runner'

export function managerDatabaseCutoverStep(input: {
  readonly database: string
  readonly originalSha256: string
  readonly backup: string
  readonly retireId: string
  readonly allowGroupWritableDirectory?: boolean
  readonly assertQuiescent: () => Promise<void>
}): CutoverStep {
  return {
    name: 'manager-database-backup',
    forward: async () => {
      await installNativeDatabase({
        staged: input.database,
        stagedSha256: input.originalSha256,
        target: input.backup,
        assertQuiescent: input.assertQuiescent,
      })
    },
    rollback: async () => {
      await input.assertQuiescent()
      let present = true
      try {
        await lstat(input.database)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        present = false
      }
      if (present) {
        try {
          await assertDatabaseSidecarsAbsent(input.database)
          if ((await privateDatabaseDigest(input.database)) === input.originalSha256) return
        } catch (error) {
          if (!(error instanceof ClaudeDatabaseRestoreError && error.code === 'SIDECAR_PRESENT')) throw error
        }
      }
      await assertDatabaseSidecarsAbsent(input.backup)
      if ((await privateDatabaseDigest(input.backup)) !== input.originalSha256) throw new ManagerDatabaseRollbackError()
      await retireNativeDatabase({
        target: input.database,
        retireId: input.retireId,
        allowGroupWritableDirectory: input.allowGroupWritableDirectory,
        assertQuiescent: input.assertQuiescent,
      })
      await installNativeDatabase({
        staged: input.backup,
        stagedSha256: input.originalSha256,
        target: input.database,
        allowGroupWritableDirectory: input.allowGroupWritableDirectory,
        assertQuiescent: input.assertQuiescent,
      })
    },
  }
}

export class ManagerDatabaseRollbackError extends Error {
  constructor() {
    super('MANAGER_DATABASE_ROLLBACK_UNVERIFIED')
    this.name = 'ManagerDatabaseRollbackError'
  }
}
