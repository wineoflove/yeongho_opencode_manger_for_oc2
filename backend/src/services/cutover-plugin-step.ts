import { lstat, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import {
  pluginIdentity,
  publishPluginCopy,
  recoverPluginCopy,
  LegacyPluginTransitionError,
} from './legacy-plugin-files'
import { syncDatabasePath } from './claude-database-files'
import type { CutoverStep } from './cutover-step-runner'

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export function newPluginCutoverStep(input: {
  readonly source: string
  readonly target: string
  readonly sha256: string
  readonly stateDirectory: string
  readonly assertQuiescent: () => Promise<void>
  readonly allowGroupWritableTarget?: boolean
}): CutoverStep {
  const intent = join(input.stateDirectory, 'plugin-install-intent.json')
  const owner = join(input.stateDirectory, 'plugin-install-owner.json')
  const retired = join(input.stateDirectory, 'plugin.retired')
  const description = JSON.stringify({
    source: input.source,
    target: input.target,
    sha256: input.sha256,
  })
  const recordedIdentity = async () =>
    z
      .object({ identity: z.string().regex(/^\d+:\d+$/) })
      .strict()
      .parse(JSON.parse(await readPrivateTransferFile(owner))).identity
  const validate = async (allowRetiredParent = false) => {
    if (![input.source, input.target, input.stateDirectory].every(isAbsolute) || !/^[a-f0-9]{64}$/.test(input.sha256))
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    for (const directory of [input.stateDirectory, dirname(input.target)]) {
      if (allowRetiredParent && directory === dirname(input.target) && !(await exists(directory))) {
        const retiredIdentity = await pluginIdentity(retired, input.sha256)
        if (!retiredIdentity || retiredIdentity !== (await recordedIdentity()))
          throw new LegacyPluginTransitionError('FILE_CHANGED')
        continue
      }
      const metadata = await lstat(directory)
      if (
        (await realpath(directory)) !== directory ||
        !metadata.isDirectory() ||
        metadata.uid !== process.getuid?.() ||
        metadata.mode & (directory === input.stateDirectory ? 0o077 : input.allowGroupWritableTarget ? 0o002 : 0o022)
      )
        throw new LegacyPluginTransitionError('INVALID_SCOPE')
    }
    await input.assertQuiescent()
  }
  return {
    name: 'install-native-model-plugin',
    forward: async () => {
      await validate()
      if (await exists(intent)) {
        if ((await readPrivateTransferFile(intent)) !== description)
          throw new LegacyPluginTransitionError('JOURNAL_MISMATCH')
        await recoverPluginCopy(input.target, input.stateDirectory, {
          sha256: input.sha256,
          identity: await recordedIdentity(),
        })
        if (
          (await readPrivateTransferFile(owner)) !==
          JSON.stringify({
            identity: await pluginIdentity(input.target, input.sha256),
          })
        )
          throw new LegacyPluginTransitionError('FILE_CHANGED')
        return
      }
      if (await exists(input.target)) throw new LegacyPluginTransitionError('FILE_CHANGED')
      if (!(await pluginIdentity(input.source, input.sha256))) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
      const pendingIntent = join(input.stateDirectory, `plugin-install-intent-${randomUUID()}.pending`)
      await durableTransferRecord(pendingIntent, JSON.parse(description))
      await publishPluginCopy({
        source: pendingIntent,
        target: intent,
        directory: input.stateDirectory,
        sha256: createHash('sha256').update(description).digest('hex'),
      })
      await publishPluginCopy({
        source: input.source,
        target: input.target,
        directory: input.stateDirectory,
        sha256: input.sha256,
        recordOwnership: async (identity) => {
          await durableTransferRecord(owner, { identity })
        },
      })
    },
    rollback: async () => {
      await validate(true)
      if (!(await exists(intent))) return
      if ((await readPrivateTransferFile(intent)) !== description)
        throw new LegacyPluginTransitionError('JOURNAL_MISMATCH')
      if (!(await exists(owner))) {
        if (await exists(input.target)) throw new LegacyPluginTransitionError('FILE_CHANGED')
        return
      }
      await recoverPluginCopy(input.target, input.stateDirectory, {
        sha256: input.sha256,
        identity: await recordedIdentity(),
      })
      const targetExists = await exists(input.target)
      const identity = await pluginIdentity(targetExists ? input.target : retired, input.sha256)
      if (!identity || (await readPrivateTransferFile(owner)) !== JSON.stringify({ identity }))
        throw new LegacyPluginTransitionError('FILE_CHANGED')
      if (targetExists) {
        if (await exists(retired)) throw new LegacyPluginTransitionError('FILE_CHANGED')
        await input.assertQuiescent()
        if ((await pluginIdentity(input.target, input.sha256)) !== identity)
          throw new LegacyPluginTransitionError('FILE_CHANGED')
        await rename(input.target, retired)
      }
      await syncDatabasePath(input.stateDirectory, true)
      if (await exists(dirname(input.target))) await syncDatabasePath(dirname(input.target), true)
    },
  }
}
