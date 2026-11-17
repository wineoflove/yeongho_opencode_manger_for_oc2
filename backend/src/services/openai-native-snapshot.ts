import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest } from './claude-database-files'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { openAiAccountHealthSchema, openAiNativeHealthSchema } from './openai-native-health'

const credentialSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  active: z.number().int().nullable(),
  value: z.string(),
})
const oauthSchema = z.object({
  type: z.literal('oauth'),
  methodID: z.literal('chatgpt-browser'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().int().nonnegative(),
  metadata: z.object({ accountID: z.string().min(1) }),
})

export class OpenAiNativeSnapshotError extends Error {
  constructor(readonly code: 'INVALID_SCOPE' | 'DATABASE_CHANGED' | 'DATABASE_IN_USE' | 'SNAPSHOT_FAILED') {
    super(code)
    this.name = 'OpenAiNativeSnapshotError'
  }
}

export async function readStoppedOpenAiCredentials(input: {
  readonly root: string
  readonly database: string
  readonly sha256: string
  readonly assertQuiescent: () => Promise<void>
}) {
  try {
    const local = relative(input.root, input.database)
    if (
      !isAbsolute(input.root) ||
      !isAbsolute(input.database) ||
      !local ||
      local.startsWith('..') ||
      isAbsolute(local) ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new OpenAiNativeSnapshotError('INVALID_SCOPE')
    const root = await lstat(input.root)
    const identity = await lstat(input.database)
    const assertIdentity = async () => {
      const currentRoot = await lstat(input.root)
      const current = await lstat(input.database)
      if (
        (await realpath(input.root)) !== input.root ||
        (await realpath(input.database)) !== input.database ||
        !currentRoot.isDirectory() ||
        currentRoot.uid !== process.getuid?.() ||
        (currentRoot.mode & 0o077) !== 0 ||
        currentRoot.dev !== root.dev ||
        currentRoot.ino !== root.ino ||
        !current.isFile() ||
        current.uid !== process.getuid?.() ||
        current.nlink !== 1 ||
        (current.mode & 0o077) !== 0 ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        throw new OpenAiNativeSnapshotError('DATABASE_CHANGED')
    }
    await assertIdentity()
    const release = await acquireClaudeDatabaseLock(`${input.database}.openai-import`)
    try {
      const assertUnused = async () => {
        await input.assertQuiescent()
        await assertIdentity()
        await assertDatabaseSidecarsAbsent(input.database)
        const holders = spawnSync('/usr/sbin/lsof', ['-t', '--', input.database], { encoding: 'utf8', timeout: 5000 })
        if (holders.error || holders.signal || holders.status !== 1 || holders.stdout.trim() || holders.stderr.trim())
          throw new OpenAiNativeSnapshotError('DATABASE_IN_USE')
        if ((await privateDatabaseDigest(input.database)) !== input.sha256)
          throw new OpenAiNativeSnapshotError('DATABASE_CHANGED')
        await assertIdentity()
      }
      await assertUnused()
      const db = new Database(input.database, {
        readonly: true,
        create: false,
      })
      let credentials: Array<{
        readonly id: string
        readonly integrationID: 'openai'
        readonly label: string
        readonly active: boolean
        readonly value: z.infer<typeof oauthSchema>
      }>
      let health: z.infer<typeof openAiNativeHealthSchema>
      try {
        z.object({ journal_mode: z.literal('delete') }).parse(db.query('PRAGMA journal_mode').get())
        credentials = credentialSchema
          .array()
          .min(1)
          .max(20)
          .parse(
            db.query("SELECT id,label,active,value FROM credential WHERE integration_id='openai' ORDER BY id").all(),
          )
          .map((entry) => ({
            id: entry.id,
            integrationID: 'openai' as const,
            label: entry.label,
            active: entry.active === 1,
            value: oauthSchema.parse(JSON.parse(entry.value)),
          }))
        const pausedRow = db.query("SELECT value FROM kv WHERE key='ocm/account-pool/state/openai'").get()
        const poolState = pausedRow
          ? z
              .object({ version: z.literal(1), paused: z.boolean() })
              .strict()
              .parse(JSON.parse(z.object({ value: z.string() }).parse(pausedRow).value))
          : { paused: false }
        const prefix = 'ocm/account-pool/account/openai/'
        const rows = z
          .array(z.object({ key: z.string(), value: z.string() }))
          .parse(
            db.query("SELECT key,value FROM kv WHERE key LIKE 'ocm/account-pool/account/openai/%' ORDER BY key").all(),
          )
        health = openAiNativeHealthSchema.parse({
          paused: poolState.paused,
          accounts: rows.map((row) => ({
            credentialID: row.key.slice(prefix.length),
            state: openAiAccountHealthSchema.parse(JSON.parse(row.value)),
          })),
        })
        if (health.accounts.some((entry) => !credentials.some((credential) => credential.id === entry.credentialID)))
          throw new OpenAiNativeSnapshotError('SNAPSHOT_FAILED')
      } finally {
        db.close()
      }
      await assertUnused()
      return {
        credentials,
        health,
        databaseSha256: input.sha256,
        phase: 'stopped-snapshot-read' as const,
      }
    } finally {
      await release()
    }
  } catch (error) {
    throw error instanceof OpenAiNativeSnapshotError ? error : new OpenAiNativeSnapshotError('SNAPSHOT_FAILED')
  }
}
