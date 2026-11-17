import { lstat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { stageClaudeTransfer, readPrivateTransferFile } from './claude-transfer-stage'
import { activateClaudeTransfer, durableTransferRecord } from './claude-transfer-activate'
import { rollbackClaudeTransfer } from './claude-transfer-rollback'
import { resumeClaudeRollback } from './claude-transfer-resume'
import { syncDatabasePath } from './claude-database-files'
import type { CutoverStep } from './cutover-step-runner'

const directorySchema = z.object({ device: z.number(), inode: z.number() }).strict()

export class ClaudeActivationStepError extends Error {
  constructor() {
    super('CLAUDE_ACTIVATION_OWNERSHIP_UNVERIFIED')
    this.name = 'ClaudeActivationStepError'
  }
}

async function directoryIdentity(path: string) {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.uid !== process.getuid?.() || entry.mode & 0o077)
      throw new ClaudeActivationStepError()
    return { device: entry.dev, inode: entry.ino }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function present(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export function claudeActivationCutoverStep(input: {
  readonly staging: Omit<Parameters<typeof stageClaudeTransfer>[0], 'nativeAuthMode'>
  readonly targetAuthDirectory: string
  readonly gateDirectory: string
}): CutoverStep & { readonly assertInstalledOwnership: () => Promise<void> } {
  const root = input.staging.stagingDirectory
  const ownerPath = join(root, 'cutover-activation-owner.json')
  const pending = join(root, 'pending-auth')
  const archive = join(root, 'auth-directory.before')
  const activation = {
    ...input.staging,
    targetAuthDirectory: input.targetAuthDirectory,
    gateDirectory: input.gateDirectory,
  }
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const readOwner = async () =>
    z
      .object({
        target: z.literal(input.targetAuthDirectory),
        original: directorySchema,
        candidate: directorySchema,
      })
      .strict()
      .parse(JSON.parse(await readPrivateTransferFile(ownerPath)))
  const assertInstalledOwnership = async () => {
    const owner = await readOwner()
    if (
      !same(await directoryIdentity(input.targetAuthDirectory), owner.candidate) ||
      !same(await directoryIdentity(archive), owner.original) ||
      (await directoryIdentity(pending))
    )
      throw new ClaudeActivationStepError()
  }
  return {
    assertInstalledOwnership,
    name: 'claude-account-activation',
    forward: async () => {
      await stageClaudeTransfer({
        ...input.staging,
        nativeAuthMode: 'preserve-anchor',
      })
      const original = await directoryIdentity(input.targetAuthDirectory)
      const candidate = await directoryIdentity(pending)
      if (!original || !candidate) throw new ClaudeActivationStepError()
      await durableTransferRecord(ownerPath, {
        target: input.targetAuthDirectory,
        original,
        candidate,
      })
      await activateClaudeTransfer({
        ...activation,
        expectedDirectories: { original, candidate },
      })
    },
    rollback: async () => {
      await input.staging.assertQuiescent()
      if (!(await present(ownerPath))) {
        if (await present(join(root, 'activation-intent.json'))) throw new ClaudeActivationStepError()
        return
      }
      const owner = await readOwner()
      const target = await directoryIdentity(input.targetAuthDirectory)
      const archived = await directoryIdentity(archive)
      const staged = await directoryIdentity(pending)
      if (same(target, owner.original) && same(staged, owner.candidate) && !archived) return
      if (!target && same(archived, owner.original) && same(staged, owner.candidate)) {
        await input.staging.assertQuiescent()
        await rename(archive, input.targetAuthDirectory)
        await syncDatabasePath(dirname(input.targetAuthDirectory), true)
        await syncDatabasePath(root, true)
        return
      }
      await assertInstalledOwnership()
      const installed = join(root, 'activation-installed.json')
      if (!(await present(installed))) {
        const intent = z
          .object({ phase: z.literal('activation-intent') })
          .parse(JSON.parse(await readPrivateTransferFile(join(root, 'activation-intent.json'))))
        if (intent.phase !== 'activation-intent') throw new ClaudeActivationStepError()
        await durableTransferRecord(installed, {
          phase: 'files-installed-services-stopped',
          recoveredFromOwnedDirectory: true,
        })
      }
      if (await present(join(root, 'rollback-intent.json'))) await resumeClaudeRollback(activation)
      else await rollbackClaudeTransfer(activation)
    },
  }
}
