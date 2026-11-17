import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { syncDatabasePath } from './claude-database-files'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { CutoverPublicationUncertainError } from './cutover-publication-error'
import type { MaintenanceLaunchdCheckpoint, MaintenanceLaunchdUnit } from './claude-maintenance-launchd'

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const unitSchema = z
  .object({
    label: z.string(),
    port: z.number().int(),
    pids: z.array(z.number().int().min(2)),
    registered: z.boolean(),
    definition: z.string(),
    definitionSha256: sha,
    sourceDefinition: z.string().optional(),
    sourceDefinitionSha256: sha.optional(),
    expectedPID: z.number().int().min(2).optional(),
    expectedStarted: z.string().min(1).optional(),
    bootstrapState: z.enum(['intent', 'accepted', 'rejected']).optional(),
    stopScope: z.literal('owner').optional(),
    ownedPorts: z.array(z.number().int()).optional(),
    stopRequired: z.array(z.object({ pid: z.number().int().min(2), started: z.string().min(1) }).strict()).optional(),
    survivingDescendants: z.number().int().nonnegative().optional(),
  })
  .strict()
const checkpointSchema = z
  .object({
    phase: z.enum([
      'bootstrap-intent',
      'bootstrap-rejected',
      'bootstrap-accepted',
      'observed',
      'observed-existing',
      'ready',
      'stop-intent',
      'stopped',
    ]),
    recordedAt: z.number().int().nonnegative(),
    unit: unitSchema,
  })
  .strict()
const recordSchema = z
  .object({
    sequence: z.number().int().positive(),
    previous: sha.nullable(),
    checkpoint: checkpointSchema,
  })
  .strict()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export async function releaseLifecycleCheckpoints(input: {
  readonly directory: string
  readonly snapshotDirectory: string
  readonly targets: readonly {
    readonly label: string
    readonly port: number
    readonly ownedPorts: readonly number[]
    readonly treeStop?: boolean
    readonly initialDefinition?: {
      readonly path: string
      readonly sha256: string
    }
    readonly sourceDefinition?: {
      readonly path: string
      readonly sha256: string
    }
  }[]
}) {
  const directories = new Map<string, { dev: number; ino: number }>()
  for (const path of [input.directory, input.snapshotDirectory]) {
    const info = await lstat(path)
    if ((await realpath(path)) !== path || !info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error('RELEASE_CHECKPOINT_SCOPE_REJECTED')
    directories.set(path, { dev: info.dev, ino: info.ino })
  }
  const assertDirectories = async () => {
    for (const [path, original] of directories) {
      const current = await lstat(path)
      if (
        (await realpath(path)) !== path ||
        !current.isDirectory() ||
        current.uid !== process.getuid?.() ||
        current.mode & 0o077 ||
        current.dev !== original.dev ||
        current.ino !== original.ino
      )
        throw new Error('RELEASE_CHECKPOINT_SCOPE_REJECTED')
    }
  }
  const latest = new Map<string, MaintenanceLaunchdUnit>()
  const release = await acquireClaudeDatabaseLock(input.directory)
  let closed = false
  let sequence = 0
  let previous: string | null = null
  let writing = false
  let failed = false
  const validate = (value: unknown) => {
    const checkpoint = checkpointSchema.parse(value)
    const expected = input.targets.find((target) => target.label === checkpoint.unit.label)
    const initial = expected?.initialDefinition
    const source = expected?.sourceDefinition
    const originalDefinition =
      initial && checkpoint.unit.definition === initial.path && checkpoint.unit.definitionSha256 === initial.sha256
    const ownSnapshot =
      checkpoint.unit.definition.startsWith(input.snapshotDirectory + '/launchd-definition-') &&
      /^launchd-definition-[a-f0-9-]{36}\.plist$/.test(
        checkpoint.unit.definition.slice(input.snapshotDirectory.length + 1),
      )
    if (
      !expected ||
      expected.port !== checkpoint.unit.port ||
      JSON.stringify(checkpoint.unit.ownedPorts ?? []) !== JSON.stringify(expected.ownedPorts) ||
      checkpoint.unit.stopScope !== (expected.treeStop ? undefined : 'owner') ||
      (checkpoint.unit.sourceDefinition === undefined) !== (checkpoint.unit.sourceDefinitionSha256 === undefined) ||
      (checkpoint.unit.sourceDefinition !== undefined &&
        (!source ||
          checkpoint.unit.sourceDefinition !== source.path ||
          checkpoint.unit.sourceDefinitionSha256 !== source.sha256)) ||
      (!originalDefinition && !ownSnapshot)
    )
      throw new Error('RELEASE_CHECKPOINT_SCOPE_REJECTED')
    return checkpoint
  }
  try {
    await assertDirectories()
    for (const name of (await readdir(input.directory)).sort()) {
      if (/^\.pending-[a-f0-9-]{36}\.json$/.test(name)) continue
      if (name !== `${String(sequence + 1).padStart(6, '0')}.json`) throw new Error('RELEASE_CHECKPOINT_CHAIN_REJECTED')
      const text = await readPrivateTransferFile(join(input.directory, name))
      const record = recordSchema.parse(JSON.parse(text))
      if (record.sequence !== sequence + 1 || record.previous !== previous)
        throw new Error('RELEASE_CHECKPOINT_CHAIN_REJECTED')
      const checkpoint = validate(record.checkpoint)
      latest.set(checkpoint.unit.label, checkpoint.unit)
      sequence = record.sequence
      previous = hash(text)
    }
    await assertDirectories()
  } catch (error) {
    await release()
    throw error
  }
  return {
    assertOpen: async () => {
      if (closed || failed) throw new Error('RELEASE_CHECKPOINT_CLOSED')
      await assertDirectories()
    },
    close: async () => {
      if (writing) throw new Error('RELEASE_CHECKPOINT_WRITE_BUSY')
      if (!closed) {
        await release()
        closed = true
      }
    },
    latest: (label: string) => structuredClone(latest.get(label)),
    persist: async (value: MaintenanceLaunchdCheckpoint) => {
      if (writing || closed || failed) throw new Error('RELEASE_CHECKPOINT_WRITE_BUSY')
      writing = true
      let published = false
      try {
        await assertDirectories()
        const checkpoint = validate(value)
        const record = { sequence: sequence + 1, previous, checkpoint }
        const target = join(input.directory, `${String(record.sequence).padStart(6, '0')}.json`)
        try {
          await lstat(target)
          throw new Error('RELEASE_CHECKPOINT_CONFLICT')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        const pending = join(input.directory, `.pending-${randomUUID()}.json`)
        await durableTransferRecord(pending, record)
        await assertDirectories()
        await rename(pending, target)
        published = true
        await syncDatabasePath(input.directory, true)
        await assertDirectories()
        sequence = record.sequence
        previous = hash(JSON.stringify(record))
        latest.set(checkpoint.unit.label, checkpoint.unit)
      } catch (error) {
        failed = published
        if (published) throw new CutoverPublicationUncertainError()
        throw error
      } finally {
        writing = false
      }
    },
  }
}
