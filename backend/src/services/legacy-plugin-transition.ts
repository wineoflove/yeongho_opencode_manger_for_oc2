import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { syncDatabasePath } from './claude-database-files'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import {
  LegacyPluginTransitionError,
  pluginIdentity,
  publishPluginCopy,
  recoverPluginCopy,
} from './legacy-plugin-files'
export { LegacyPluginTransitionError } from './legacy-plugin-files'

const entrySchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|ts)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Entry = z.infer<typeof entrySchema>
type Input = {
  readonly sourceDirectory: string
  readonly archiveDirectory: string
  readonly entries: readonly Entry[]
  readonly assertQuiescent: () => Promise<void>
  readonly allowGroupWritableSource?: boolean
}

async function directoryIdentity(path: string, allowGroupWritable = false) {
  const stat = await lstat(path)
  if (
    (await realpath(path)) !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & (allowGroupWritable ? 0o002 : 0o022)) !== 0
  )
    throw new LegacyPluginTransitionError('INVALID_SCOPE')
  return `${stat.dev}:${stat.ino}`
}

export async function transitionLegacyPlugins(input: Input, direction: 'archive' | 'restore') {
  try {
    const entries = z.array(entrySchema).min(1).max(64).parse(input.entries)
    if (
      !['archive', 'restore'].includes(direction) ||
      ![input.sourceDirectory, input.archiveDirectory].every(isAbsolute) ||
      new Set(entries.map((entry) => entry.name)).size !== entries.length
    )
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    const archiveRelative = relative(input.sourceDirectory, input.archiveDirectory)
    if (
      !archiveRelative.startsWith('..' + sep) ||
      !relative(input.archiveDirectory, input.sourceDirectory).startsWith('..' + sep)
    )
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    const sourceIdentity = await directoryIdentity(input.sourceDirectory, input.allowGroupWritableSource === true)
    const parentIdentity = await directoryIdentity(dirname(input.archiveDirectory))
    if ((await lstat(input.sourceDirectory)).dev !== (await lstat(dirname(input.archiveDirectory))).dev)
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    await input.assertQuiescent()
    if (
      (await directoryIdentity(input.sourceDirectory, input.allowGroupWritableSource === true)) !== sourceIdentity ||
      (await directoryIdentity(dirname(input.archiveDirectory))) !== parentIdentity
    )
      throw new LegacyPluginTransitionError('INVALID_SCOPE')
    const release = await acquireClaudeDatabaseLock(input.archiveDirectory)
    try {
      const manifest = {
        version: 1,
        sourceDirectory: input.sourceDirectory,
        entries,
      }
      const manifestPath = join(input.archiveDirectory, 'manifest.json')
      let archiveExists = true
      try {
        await lstat(input.archiveDirectory)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        archiveExists = false
      }
      if (!archiveExists) {
        if (direction !== 'archive') throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
        for (const entry of entries)
          if (!(await pluginIdentity(join(input.sourceDirectory, entry.name), entry.sha256)))
            throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
        const pending = `${input.archiveDirectory}.pending-${randomUUID()}`
        await mkdir(pending, { mode: 0o700 })
        await durableTransferRecord(join(pending, 'manifest.json'), manifest)
        await rename(pending, input.archiveDirectory)
      }
      await syncDatabasePath(dirname(input.archiveDirectory), true)
      const archiveIdentity = await directoryIdentity(input.archiveDirectory)
      if (((await lstat(input.archiveDirectory)).mode & 0o077) !== 0)
        throw new LegacyPluginTransitionError('INVALID_SCOPE')
      if (!isDeepStrictEqual(JSON.parse(await readPrivateTransferFile(manifestPath)), manifest))
        throw new LegacyPluginTransitionError('JOURNAL_MISMATCH')
      const check = async () => {
        await input.assertQuiescent()
        if (((await lstat(input.archiveDirectory)).mode & 0o077) !== 0)
          throw new LegacyPluginTransitionError('INVALID_SCOPE')
        if (!isDeepStrictEqual(JSON.parse(await readPrivateTransferFile(manifestPath)), manifest))
          throw new LegacyPluginTransitionError('JOURNAL_MISMATCH')
        if (
          (await directoryIdentity(input.sourceDirectory, input.allowGroupWritableSource === true)) !==
            sourceIdentity ||
          (await directoryIdentity(dirname(input.archiveDirectory))) !== parentIdentity ||
          (await directoryIdentity(input.archiveDirectory)) !== archiveIdentity
        )
          throw new LegacyPluginTransitionError('INVALID_SCOPE')
      }
      let changed = 0
      for (const entry of entries) {
        await check()
        const source = join(input.sourceDirectory, entry.name)
        const archive = join(input.archiveDirectory, `${entry.name}.original`)
        await recoverPluginCopy(source, input.archiveDirectory, entry.sha256)
        await recoverPluginCopy(archive, input.archiveDirectory, entry.sha256)
        const sourceFile = await pluginIdentity(source, entry.sha256)
        if (direction === 'archive') {
          if (!(await pluginIdentity(archive, entry.sha256))) {
            if (!sourceFile) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
            await publishPluginCopy({
              source,
              target: archive,
              directory: input.archiveDirectory,
              sha256: entry.sha256,
            })
          }
          const archivedFile = await pluginIdentity(archive, entry.sha256)
          if (!archivedFile) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
          await syncDatabasePath(archive)
          await syncDatabasePath(input.archiveDirectory, true)
          await check()
          if ((await pluginIdentity(archive, entry.sha256)) !== archivedFile)
            throw new LegacyPluginTransitionError('FILE_CHANGED')
          if (sourceFile) {
            if ((await pluginIdentity(source, entry.sha256)) !== sourceFile)
              throw new LegacyPluginTransitionError('FILE_CHANGED')
            await unlink(source)
            changed++
          }
        } else if (!sourceFile) {
          if (!(await pluginIdentity(archive, entry.sha256))) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
          await publishPluginCopy({
            source: archive,
            target: source,
            directory: input.archiveDirectory,
            sha256: entry.sha256,
          })
          if (!(await pluginIdentity(source, entry.sha256))) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
          await syncDatabasePath(source)
          changed++
        }
        if (direction === 'restore') await syncDatabasePath(source)
        await syncDatabasePath(input.sourceDirectory, true)
      }
      await check()
      for (const entry of entries) {
        const source = await pluginIdentity(join(input.sourceDirectory, entry.name), entry.sha256)
        if (direction === 'archive') {
          if (source || !(await pluginIdentity(join(input.archiveDirectory, `${entry.name}.original`), entry.sha256)))
            throw new LegacyPluginTransitionError('FILE_CHANGED')
        } else if (!source) throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
      }
      return {
        phase: direction === 'archive' ? 'listed-legacy-plugins-archived' : 'listed-legacy-plugins-restored',
        changed,
        files: entries.length,
        servicesRestarted: false,
      }
    } finally {
      await release()
    }
  } catch (error) {
    throw error instanceof LegacyPluginTransitionError ? error : new LegacyPluginTransitionError('TRANSITION_FAILED')
  }
}
