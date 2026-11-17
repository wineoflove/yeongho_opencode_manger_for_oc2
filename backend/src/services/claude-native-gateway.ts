import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { readPrivateTransferFile } from './claude-transfer-stage'

const credentialID = 'cred_ocm_claude_gateway'
const markerKey = 'ocm/transfer/anthropic/gateway'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const markerSchema = z
  .object({
    version: z.literal(1),
    beforeSha256: z.string(),
    keySha256: z.string(),
    preservedSha256: z.string(),
  })
  .strict()

export class ClaudeNativeGatewayError extends Error {
  constructor(
    readonly code:
      'INVALID_SCOPE' | 'DATABASE_CHANGED' | 'DATABASE_IN_USE' | 'CREDENTIAL_CONFLICT' | 'GATEWAY_PREPARATION_FAILED',
  ) {
    super(code)
    this.name = 'ClaudeNativeGatewayError'
  }
}

export async function activateClaudeGatewayInStoppedCopy(input: {
  readonly root: string
  readonly database: string
  readonly sha256: string
  readonly keyFile: string
  readonly keySha256: string
  readonly assertQuiescent: () => Promise<void>
}) {
  try {
    const local = relative(input.root, input.database)
    if (
      ![input.root, input.database, input.keyFile].every(isAbsolute) ||
      !local ||
      local.startsWith('..') ||
      isAbsolute(local) ||
      ![input.sha256, input.keySha256].every((value) => /^[a-f0-9]{64}$/.test(value))
    )
      throw new ClaudeNativeGatewayError('INVALID_SCOPE')
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
        throw new ClaudeNativeGatewayError('DATABASE_CHANGED')
    }
    await assertIdentity()
    const release = await acquireClaudeDatabaseLock(`${input.database}.openai-import`)
    try {
      await input.assertQuiescent()
      await assertIdentity()
      await assertDatabaseSidecarsAbsent(input.database)
      const holders = spawnSync('/usr/sbin/lsof', ['-t', '--', input.database], { encoding: 'utf8', timeout: 5000 })
      if (holders.error || holders.signal || holders.status !== 1 || holders.stdout.trim() || holders.stderr.trim())
        throw new ClaudeNativeGatewayError('DATABASE_IN_USE')
      const key = await readPrivateTransferFile(input.keyFile)
      if (!/^[a-f0-9]{64}$/.test(key) || hash(key) !== input.keySha256)
        throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
      const before = await privateDatabaseDigest(input.database)
      await assertIdentity()
      const db = new Database(input.database, { create: false })
      let committed = false
      let began = false
      let reused = false
      try {
        db.run('BEGIN IMMEDIATE')
        began = true
        z.object({ journal_mode: z.literal('delete') }).parse(db.query('PRAGMA journal_mode').get())
        if ((await privateDatabaseDigest(input.database)) !== before)
          throw new ClaudeNativeGatewayError('DATABASE_CHANGED')
        await assertIdentity()
        const preserved = () => db.query('SELECT * FROM credential WHERE id != ? ORDER BY id').all(credentialID)
        const existing = db.query('SELECT integration_id,value,active FROM credential WHERE id=?').get(credentialID)
        const saved = db.query('SELECT value FROM kv WHERE key=?').get(markerKey)
        const value = JSON.stringify({ type: 'key', key })
        if (saved) {
          const marker = markerSchema.parse(JSON.parse(z.object({ value: z.string() }).parse(saved).value))
          if (
            marker.beforeSha256 !== input.sha256 ||
            marker.keySha256 !== input.keySha256 ||
            marker.preservedSha256 !== hash(JSON.stringify(preserved()))
          )
            throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
          reused = true
        } else {
          if (before !== input.sha256) throw new ClaudeNativeGatewayError('DATABASE_CHANGED')
          if (existing) throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
          const expectedPreserved = z
            .array(z.record(z.string(), z.unknown()))
            .parse(preserved())
            .map((row) => (row.integration_id === 'anthropic' && row.active === 1 ? { ...row, active: 0 } : row))
          db.query("UPDATE credential SET active=0 WHERE integration_id='anthropic' AND active=1").run()
          const now = Date.now()
          db.query(
            'INSERT INTO credential (id,integration_id,label,value,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?)',
          ).run(credentialID, 'anthropic', 'Manager Claude gateway', value, 1, now, now)
          const marker = {
            version: 1,
            beforeSha256: input.sha256,
            keySha256: input.keySha256,
            preservedSha256: hash(JSON.stringify(expectedPreserved)),
          }
          db.query('INSERT INTO kv (key,value,time_created,time_updated) VALUES (?,?,?,?)').run(
            markerKey,
            JSON.stringify(marker),
            now,
            now,
          )
          const writtenMarker = z
            .object({ value: z.string() })
            .parse(db.query('SELECT value FROM kv WHERE key=?').get(markerKey))
          if (writtenMarker.value !== JSON.stringify(marker)) throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
          if (hash(JSON.stringify(preserved())) !== marker.preservedSha256)
            throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
        }
        const gateway = z
          .object({
            integration_id: z.literal('anthropic'),
            value: z.literal(value),
            active: z.literal(1),
          })
          .safeParse(db.query('SELECT integration_id,value,active FROM credential WHERE id=?').get(credentialID))
        const otherActive = db
          .query("SELECT id FROM credential WHERE integration_id='anthropic' AND active=1 AND id != ?")
          .all(credentialID)
        if (!gateway.success || otherActive.length) throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
        await input.assertQuiescent()
        if ((await readPrivateTransferFile(input.keyFile)) !== key)
          throw new ClaudeNativeGatewayError('CREDENTIAL_CONFLICT')
        await assertIdentity()
        db.run('COMMIT')
        committed = true
      } catch (error) {
        if (began && !committed) db.run('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
      await syncDatabasePath(input.database)
      await syncDatabasePath(dirname(input.database), true)
      return {
        phase: 'gateway-key-active-in-stopped-copy',
        reused,
        credentialID,
        nativeRuntimeStarted: false,
        refreshOwnershipTransferred: false,
      }
    } finally {
      await release()
    }
  } catch (error) {
    throw error instanceof ClaudeNativeGatewayError ? error : new ClaudeNativeGatewayError('GATEWAY_PREPARATION_FAILED')
  }
}
