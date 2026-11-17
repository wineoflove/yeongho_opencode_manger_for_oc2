import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { assertDatabaseSidecarsAbsent, privateDatabaseDigest, syncDatabasePath } from './claude-database-files'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { validateOpenAiTransferCandidate } from './openai-transfer-candidate'
import { acquireClaudeDatabaseLock } from './claude-database-lock'
import { matchesOpenAiImportedPoolState } from './openai-import-pool-state'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'

const markerKey = 'ocm/transfer/openai/offline-import'
const rowSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  active: z.number().nullable(),
})
const markerSchema = z
  .object({
    version: z.literal(1),
    ledgerSha256: z.string(),
    sourceSha256: z.string(),
    targetBeforeSha256: z.string(),
    credentialCount: z.number().int(),
  })
  .strict()

export class OpenAiOfflineImportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TARGET'
      | 'TARGET_CHANGED'
      | 'TARGET_IN_USE'
      | 'TARGET_CONFLICT'
      | 'SOURCE_CHANGED'
      | 'IMPORT_FAILED'
      | 'IMPORT_DURABILITY_UNCONFIRMED',
  ) {
    super(code)
    this.name = 'OpenAiOfflineImportError'
  }
}

type OfflineImportInput = {
  readonly expectedSourceSha256?: string
  readonly candidate: Parameters<typeof validateOpenAiTransferCandidate>[0]
  readonly target: {
    readonly root: string
    readonly database: string
    readonly sha256: string
  }
}

export async function importOpenAiIntoStoppedCopy(input: OfflineImportInput) {
  const { target } = input
  if (
    ![target.root, target.database].every(isAbsolute) ||
    !/^[a-f0-9]{64}$/.test(target.sha256) ||
    (await realpath(target.root)) !== target.root ||
    (await realpath(target.database)) !== target.database
  )
    throw new OpenAiOfflineImportError('INVALID_TARGET')
  const location = relative(target.root, target.database)
  const root = await lstat(target.root)
  if (
    !location ||
    location.startsWith('..') ||
    isAbsolute(location) ||
    !root.isDirectory() ||
    root.uid !== process.getuid?.() ||
    (root.mode & 0o077) !== 0
  )
    throw new OpenAiOfflineImportError('INVALID_TARGET')
  const release = await acquireClaudeDatabaseLock(target.database + '.openai-import')
  try {
    return await importLocked(input)
  } finally {
    await release()
  }
}

async function importLocked(input: OfflineImportInput) {
  const { target } = input
  const candidate = await validateOpenAiTransferCandidate(input.candidate)
  if (input.expectedSourceSha256 !== undefined && candidate.sourceSha256 !== input.expectedSourceSha256)
    throw new OpenAiOfflineImportError('SOURCE_CHANGED')
  await input.candidate.assertQuiescent()
  if ((await realpath(target.root)) !== target.root || (await realpath(target.database)) !== target.database)
    throw new OpenAiOfflineImportError('TARGET_CHANGED')
  const rootIdentity = await lstat(target.root)
  await assertDatabaseSidecarsAbsent(target.database)
  const handles = spawnSync('/usr/sbin/lsof', ['-t', '--', target.database], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (handles.error || handles.signal || handles.status !== 1 || handles.stdout.trim() || handles.stderr.trim())
    throw new OpenAiOfflineImportError('TARGET_IN_USE')
  const anchor = await open(target.database, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const identity = await anchor.stat()
    const assertIdentity = () => {
      const currentRoot = lstatSync(target.root)
      const current = lstatSync(target.database)
      if (
        realpathSync(target.root) !== target.root ||
        realpathSync(target.database) !== target.database ||
        currentRoot.dev !== rootIdentity.dev ||
        currentRoot.ino !== rootIdentity.ino ||
        !currentRoot.isDirectory() ||
        currentRoot.uid !== process.getuid?.() ||
        (currentRoot.mode & 0o077) !== 0 ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        !current.isFile() ||
        current.uid !== process.getuid?.() ||
        current.nlink !== 1 ||
        (current.mode & 0o077) !== 0
      )
        throw new OpenAiOfflineImportError('TARGET_CHANGED')
    }
    const beforeSha256 = await privateDatabaseDigest(target.database)
    assertIdentity()
    const expectedRows = candidate.credentials
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: JSON.stringify(entry.value),
        active: entry.id === candidate.activeCredentialID ? 1 : 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const marker = {
      version: 1 as const,
      ledgerSha256: candidate.ledgerSha256,
      sourceSha256: candidate.sourceSha256,
      targetBeforeSha256: target.sha256,
      credentialCount: expectedRows.length,
    }
    const db = new Database(target.database, { create: false })
    let committed = false
    let transactionStarted = false
    let reused = false
    try {
      db.run('BEGIN IMMEDIATE')
      transactionStarted = true
      assertIdentity()
      const mode = z.object({ journal_mode: z.literal('delete') }).safeParse(db.query('PRAGMA journal_mode').get())
      if (!mode.success || (await privateDatabaseDigest(target.database)) !== beforeSha256)
        throw new OpenAiOfflineImportError('TARGET_CHANGED')
      assertIdentity()
      const accountStates = candidate.rotation.accountStates ?? []
      const existingMarker = db.query('SELECT value FROM kv WHERE key=?').get(markerKey)
      const rows = rowSchema
        .array()
        .parse(db.query("SELECT id,label,value,active FROM credential WHERE integration_id='openai'").all())
        .sort((a, b) => a.id.localeCompare(b.id))
      if (existingMarker) {
        if (!matchesOpenAiImportedPoolState(db, accountStates)) throw new OpenAiOfflineImportError('TARGET_CONFLICT')
        const saved = z.object({ value: z.string() }).parse(existingMarker)
        if (
          JSON.stringify(markerSchema.parse(JSON.parse(saved.value))) !== JSON.stringify(marker) ||
          JSON.stringify(rows) !== JSON.stringify(expectedRows)
        )
          throw new OpenAiOfflineImportError('TARGET_CONFLICT')
        const cursor = z
          .object({ value: z.string() })
          .parse(db.query('SELECT value FROM kv WHERE key=?').get(candidate.rotation.cursor.key))
        if (cursor.value !== JSON.stringify(candidate.rotation.cursor.value))
          throw new OpenAiOfflineImportError('TARGET_CONFLICT')
        reused = true
      } else {
        if (beforeSha256 !== target.sha256) throw new OpenAiOfflineImportError('TARGET_CHANGED')
        const priorPool = db
          .query(
            "SELECT key FROM kv WHERE key IN ('ocm/account-pool/cursor/openai','ocm/account-pool/state/openai') OR key LIKE 'ocm/account-pool/account/openai/%'",
          )
          .all()
        if (rows.length || priorPool.length) throw new OpenAiOfflineImportError('TARGET_CONFLICT')
        const now = Date.now()
        for (const row of expectedRows)
          db.query(
            'INSERT INTO credential (id,integration_id,label,value,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?)',
          ).run(row.id, 'openai', row.label, row.value, row.active, now, now)
        db.query('INSERT INTO kv (key,value,time_created,time_updated) VALUES (?,?,?,?)').run(
          candidate.rotation.cursor.key,
          JSON.stringify(candidate.rotation.cursor.value),
          now,
          now,
        )
        db.query('INSERT INTO kv (key,value,time_created,time_updated) VALUES (?,?,?,?)').run(
          markerKey,
          JSON.stringify(marker),
          now,
          now,
        )
        for (const entry of accountStates)
          db.query('INSERT INTO kv (key,value,time_created,time_updated) VALUES (?,?,?,?)').run(
            entry.key,
            JSON.stringify(entry.value),
            now,
            now,
          )
        const written = rowSchema
          .array()
          .parse(db.query("SELECT id,label,value,active FROM credential WHERE integration_id='openai'").all())
          .sort((a, b) => a.id.localeCompare(b.id))
        if (JSON.stringify(written) !== JSON.stringify(expectedRows))
          throw new OpenAiOfflineImportError('TARGET_CONFLICT')
        const savedCursor = z
          .object({ value: z.string() })
          .safeParse(db.query('SELECT value FROM kv WHERE key=?').get(candidate.rotation.cursor.key))
        const savedMarker = z
          .object({ value: z.string() })
          .safeParse(db.query('SELECT value FROM kv WHERE key=?').get(markerKey))
        if (
          !savedCursor.success ||
          savedCursor.data.value !== JSON.stringify(candidate.rotation.cursor.value) ||
          !savedMarker.success ||
          savedMarker.data.value !== JSON.stringify(marker)
        )
          throw new OpenAiOfflineImportError('TARGET_CONFLICT')
      }
      if (!matchesOpenAiImportedPoolState(db, accountStates)) throw new OpenAiOfflineImportError('TARGET_CONFLICT')
      const source = await readPrivateTransferFile(input.candidate.sourceFile)
      if (createHash('sha256').update(source).digest('hex') !== candidate.sourceSha256)
        throw new OpenAiOfflineImportError('SOURCE_CHANGED')
      if (Date.now() + input.candidate.executionBudgetMs >= candidate.rotation.validUntil)
        throw new OpenAiOfflineImportError('SOURCE_CHANGED')
      assertIdentity()
      db.run('COMMIT')
      committed = true
    } catch (error) {
      if (transactionStarted && !committed) db.run('ROLLBACK')
      throw error instanceof OpenAiOfflineImportError ? error : new OpenAiOfflineImportError('IMPORT_FAILED')
    } finally {
      db.close()
    }
    try {
      await syncDatabasePath(target.database)
      await syncDatabasePath(dirname(target.database), true)
    } catch {
      throw new OpenAiOfflineImportError('IMPORT_DURABILITY_UNCONFIRMED')
    }
    return {
      phase: 'imported-to-stopped-copy',
      credentialCount: expectedRows.length,
      reused,
      activeSelectionPrepared: true,
      poolConfigurationApplied: false,
      nativeRuntimeStarted: false,
      refreshOwnershipTransferred: false,
      executable: false,
    }
  } finally {
    await anchor.close()
  }
}
