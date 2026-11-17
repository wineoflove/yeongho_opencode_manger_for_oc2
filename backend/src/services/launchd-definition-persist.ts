import { lstat, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { dirname, isAbsolute, join } from 'node:path'
import { applyConfigCandidate, restoreConfigOriginal } from './config-file-swap'
import { syncDatabasePath } from './claude-database-files'
import { pluginIdentity, publishPluginCopy, recoverPluginCopy } from './legacy-plugin-files'
import { durableTransferRecord } from './claude-transfer-activate'
import type { CutoverStep } from './cutover-step-runner'

type Replacement = {
  readonly label: 'io.wineoflove.ocm.backend' | 'io.wineoflove.ocm.frontend'
  readonly originalSha256: string
  readonly candidate: string
  readonly candidateSha256: string
}
type DefinitionPlan = {
  readonly agentsDirectory: string
  readonly archiveDirectory: string
  readonly replacements: readonly Replacement[]
  readonly terminalSha256: string
  readonly proxy: { readonly candidate: string; readonly sha256: string }
  readonly assertQuiescent: () => Promise<void>
}

export class LaunchdDefinitionPersistError extends Error {
  constructor(readonly code: 'INVALID_SCOPE' | 'SOURCE_CHANGED' | 'MISSING_ORIGINAL') {
    super(code)
    this.name = 'LaunchdDefinitionPersistError'
  }
}

export function launchdDefinitionSteps(plan: DefinitionPlan): readonly CutoverStep[] {
  const validate = async () => {
    const directories = [plan.agentsDirectory, plan.archiveDirectory]
    if (directories[0] === directories[1]) throw new LaunchdDefinitionPersistError('INVALID_SCOPE')
    for (const directory of directories) {
      const metadata = await lstat(directory)
      if (
        !isAbsolute(directory) ||
        (await realpath(directory)) !== directory ||
        !metadata.isDirectory() ||
        metadata.uid !== process.getuid?.() ||
        metadata.mode & 0o022
      )
        throw new LaunchdDefinitionPersistError('INVALID_SCOPE')
    }
    if ((await lstat(plan.archiveDirectory)).mode & 0o077) throw new LaunchdDefinitionPersistError('INVALID_SCOPE')
    await plan.assertQuiescent()
  }
  const ensureCopy = async (source: string, target: string, sha256: string) => {
    await validate()
    if (!(await pluginIdentity(source, sha256))) throw new LaunchdDefinitionPersistError('MISSING_ORIGINAL')
    await recoverPluginCopy(target, plan.archiveDirectory, sha256)
    if (!(await pluginIdentity(target, sha256)))
      await publishPluginCopy({
        source,
        target,
        directory: plan.archiveDirectory,
        sha256,
      })
    await syncDatabasePath(target)
    await syncDatabasePath(dirname(target), true)
  }
  const archive = async (source: string, target: string, sha256: string) => {
    await validate()
    await recoverPluginCopy(target, plan.archiveDirectory, sha256)
    const identity = await pluginIdentity(source, sha256)
    if (!identity) {
      if (!(await pluginIdentity(target, sha256))) throw new LaunchdDefinitionPersistError('MISSING_ORIGINAL')
      return
    }
    await ensureCopy(source, target, sha256)
    await plan.assertQuiescent()
    if ((await pluginIdentity(source, sha256)) !== identity || !(await pluginIdentity(target, sha256)))
      throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
    await unlink(source)
    await syncDatabasePath(dirname(source), true)
  }
  const replacements = plan.replacements.map((entry): CutoverStep => {
    const input = {
      target: join(plan.agentsDirectory, `${entry.label}.plist`),
      archiveDirectory: plan.archiveDirectory,
      originalSha256: entry.originalSha256,
      candidateSha256: entry.candidateSha256,
      assertQuiescent: validate,
    }
    return {
      name: entry.label.endsWith('.backend') ? 'persist-backend' : 'persist-frontend',
      forward: async () => {
        await applyConfigCandidate({
          ...input,
          candidate: await readFile(entry.candidate, 'utf8'),
        })
      },
      rollback: async () => {
        await restoreConfigOriginal(input)
      },
    }
  })
  const terminal = join(plan.agentsDirectory, 'io.wineoflove.ocm.terminal.plist')
  const terminalArchive = join(plan.archiveDirectory, 'terminal.original.plist')
  const proxy = join(plan.agentsDirectory, 'com.aion.ocm.claude-proxy.plist')
  const proxyArchive = join(plan.archiveDirectory, 'proxy.retired.plist')
  const proxyIntent = join(plan.archiveDirectory, 'proxy-add-intent.json')
  const proxyOwner = join(plan.archiveDirectory, 'proxy-owner.json')
  const ownerIdentity = async () =>
    z
      .object({ identity: z.string().regex(/^\d+:\d+$/) })
      .strict()
      .parse(JSON.parse(await readPrivateTransferFile(proxyOwner))).identity
  const intentText = JSON.stringify({
    target: proxy,
    sha256: plan.proxy.sha256,
  })
  const hasIntent = async () => {
    await recoverPluginCopy(proxyIntent, plan.archiveDirectory, createHash('sha256').update(intentText).digest('hex'))
    try {
      if ((await readFile(proxyIntent, 'utf8')) !== intentText)
        throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
  return [
    ...replacements,
    {
      name: 'persist-terminal-retirement',
      forward: () => archive(terminal, terminalArchive, plan.terminalSha256),
      rollback: async () => {
        await validate()
        await recoverPluginCopy(terminal, plan.archiveDirectory, plan.terminalSha256)
        if (await pluginIdentity(terminal, plan.terminalSha256)) {
          await syncDatabasePath(terminal)
          await syncDatabasePath(plan.agentsDirectory, true)
          return
        }
        await ensureCopy(terminalArchive, terminal, plan.terminalSha256)
      },
    },
    {
      name: 'persist-proxy',
      forward: async () => {
        await validate()
        if (!(await hasIntent())) {
          if (await pluginIdentity(proxy, plan.proxy.sha256)) throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
          const pending = join(plan.archiveDirectory, `proxy-add-intent-${randomUUID()}.pending`)
          await durableTransferRecord(pending, {
            target: proxy,
            sha256: plan.proxy.sha256,
          })
          await publishPluginCopy({
            source: pending,
            target: proxyIntent,
            directory: plan.archiveDirectory,
            sha256: createHash('sha256').update(intentText).digest('hex'),
          })
        }
        let owner: string | undefined
        try {
          owner = await ownerIdentity()
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (owner) {
          await recoverPluginCopy(proxy, plan.archiveDirectory, {
            sha256: plan.proxy.sha256,
            identity: owner,
          })
          if ((await pluginIdentity(proxy, plan.proxy.sha256)) !== owner)
            throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
        } else {
          if (await pluginIdentity(proxy, plan.proxy.sha256)) throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
          await publishPluginCopy({
            source: plan.proxy.candidate,
            target: proxy,
            directory: plan.archiveDirectory,
            sha256: plan.proxy.sha256,
            recordOwnership: async (identity) => {
              await durableTransferRecord(proxyOwner, { identity })
            },
          })
        }
        await syncDatabasePath(proxy)
        await syncDatabasePath(plan.agentsDirectory, true)
      },
      rollback: async () => {
        await validate()
        if (!(await hasIntent())) return
        const owner = await ownerIdentity()
        await recoverPluginCopy(proxy, plan.archiveDirectory, {
          sha256: plan.proxy.sha256,
          identity: owner,
        })
        const current = await pluginIdentity(proxy, plan.proxy.sha256)
        if (!current) {
          if ((await pluginIdentity(proxyArchive, plan.proxy.sha256)) !== owner)
            throw new LaunchdDefinitionPersistError('MISSING_ORIGINAL')
          return
        }
        if (current !== owner) throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
        if (await pluginIdentity(proxyArchive, plan.proxy.sha256))
          throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
        await plan.assertQuiescent()
        if ((await pluginIdentity(proxy, plan.proxy.sha256)) !== owner)
          throw new LaunchdDefinitionPersistError('SOURCE_CHANGED')
        await rename(proxy, proxyArchive)
        await syncDatabasePath(plan.agentsDirectory, true)
        await syncDatabasePath(plan.archiveDirectory, true)
      },
    },
  ]
}
