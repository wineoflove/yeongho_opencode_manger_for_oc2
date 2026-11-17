import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { installNativeDatabase, retireNativeDatabase } from './native-database-install'
import { assertDatabaseSidecarsAbsent } from './claude-database-files'
import type { CutoverStep } from './cutover-step-runner'

export class NativeCutoverStepError extends Error {
  constructor(readonly code: 'INVALID_SCOPE' | 'TARGET_PRESENT' | 'OWNERSHIP_UNVERIFIED') {
    super(code)
    this.name = 'NativeCutoverStepError'
  }
}

async function identity(path: string) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink < 1)
      throw new NativeCutoverStepError('OWNERSHIP_UNVERIFIED')
    return { device: stat.dev, inode: stat.ino }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export function nativeDatabaseCutoverStep(input: {
  readonly install: Parameters<typeof installNativeDatabase>[0]
  readonly stateDirectory: string
  readonly retireId: string
  readonly returnCredentials: (owner: { readonly device: number; readonly inode: number }) => Promise<void>
}): CutoverStep {
  const intentPath = join(input.stateDirectory, 'native-install-intent.json')
  const installedPath = join(input.stateDirectory, 'native-installed.json')
  const intent = {
    version: 1,
    staged: input.install.staged,
    stagedSha256: input.install.stagedSha256,
    target: input.install.target,
    retireId: input.retireId,
  }
  const validate = async () => {
    const state = await lstat(input.stateDirectory)
    if (
      !isAbsolute(input.stateDirectory) ||
      (await realpath(input.stateDirectory)) !== input.stateDirectory ||
      !state.isDirectory() ||
      state.uid !== process.getuid?.() ||
      state.mode & 0o077 ||
      !/^[a-z0-9-]{8,64}$/.test(input.retireId)
    )
      throw new NativeCutoverStepError('INVALID_SCOPE')
    await input.install.assertQuiescent()
  }
  const assertIntent = async () => {
    if ((await readPrivateTransferFile(intentPath)) !== JSON.stringify(intent))
      throw new NativeCutoverStepError('OWNERSHIP_UNVERIFIED')
  }
  const readOwner = async () =>
    z
      .object({
        target: z.literal(input.install.target),
        device: z.number().int(),
        inode: z.number().int(),
      })
      .strict()
      .parse(JSON.parse(await readPrivateTransferFile(installedPath)))
  return {
    name: 'native-database-install',
    forward: async () => {
      await validate()
      if (await identity(intentPath)) {
        await assertIntent()
        const owner = await readOwner()
        const current = await identity(input.install.target)
        if (!current || current.device !== owner.device || current.inode !== owner.inode)
          throw new NativeCutoverStepError('OWNERSHIP_UNVERIFIED')
        await installNativeDatabase(input.install)
        return
      }
      await assertDatabaseSidecarsAbsent(input.install.target)
      if (await identity(input.install.target)) throw new NativeCutoverStepError('TARGET_PRESENT')
      await durableTransferRecord(intentPath, intent)
      await installNativeDatabase({
        ...input.install,
        recordOwnership: async (owner) => {
          await durableTransferRecord(installedPath, {
            target: input.install.target,
            ...owner,
          })
        },
      })
    },
    rollback: async () => {
      await validate()
      if (!(await identity(intentPath))) return
      await assertIntent()
      const current = await identity(input.install.target)
      const retiredPath = `${input.install.target}.retired-${input.retireId}`
      if (!current && !(await identity(installedPath))) {
        await assertDatabaseSidecarsAbsent(input.install.target)
        return
      }
      const owner = await readOwner()
      const observed = current ?? (await identity(retiredPath))
      if (!observed || observed.device !== owner.device || observed.inode !== owner.inode)
        throw new NativeCutoverStepError('OWNERSHIP_UNVERIFIED')
      if (!current) {
        await retireNativeDatabase({
          target: input.install.target,
          retireId: input.retireId,
          retirementDirectory: input.stateDirectory,
          assertQuiescent: input.install.assertQuiescent,
          allowGroupWritableDirectory: input.install.allowGroupWritableDirectory,
        })
        await assertDatabaseSidecarsAbsent(input.install.target)
        return
      }
      if ((await lstat(input.install.target)).nlink !== 1) await installNativeDatabase(input.install)
      await input.returnCredentials({
        device: owner.device,
        inode: owner.inode,
      })
      await validate()
      const after = await identity(input.install.target)
      if (!after || after.device !== owner.device || after.inode !== owner.inode)
        throw new NativeCutoverStepError('OWNERSHIP_UNVERIFIED')
      await retireNativeDatabase({
        retirementDirectory: input.stateDirectory,
        target: input.install.target,
        retireId: input.retireId,
        allowGroupWritableDirectory: input.install.allowGroupWritableDirectory,
        assertQuiescent: input.install.assertQuiescent,
      })
    },
  }
}
