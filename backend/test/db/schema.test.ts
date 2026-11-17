import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initializeDatabase } from '../../src/db/schema'
import { getRepoById } from '../../src/db/queries'

describe('initializeDatabase', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ocm-db-'))
    dbPath = path.join(tempDir, 'nested', 'opencode.db')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates the database file, applies migrations, and seeds defaults', async () => {
    const db = initializeDatabase(dbPath)

    const migrations = db.prepare('SELECT id AS name FROM applied_migrations').all() as Array<{ name: string }>
    expect(migrations.map(migration => migration.name)).toContain('001-base-schema')
    expect(migrations.map(migration => migration.name)).toContain('019-drop-opencode-configs')

    const preferences = db.prepare('SELECT preferences FROM user_preferences WHERE user_id = ?').get('default') as { preferences: string }
    expect(preferences.preferences).toBe('{}')

    expect(getRepoById(db, 0)?.localPath).toBe('assistant')

    db.close()

    const fileContents = await readFile(dbPath, 'utf-8')
    expect(fileContents.length).toBeGreaterThan(0)
  })

  it('waits for another process to release its lock instead of failing a write', async () => {
    const db = initializeDatabase(dbPath)
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(${JSON.stringify(dbPath)})
db.exec('BEGIN EXCLUSIVE')
process.stdout.write('locked\\n')
setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    try {
      const [chunk] = (await once(holder.stdout, 'data')) as [Buffer]
      expect(chunk.toString()).toContain('locked')
      expect(
        db.prepare('UPDATE user_preferences SET updated_at = ? WHERE user_id = ?').run(1, 'default').changes,
      ).toBe(1)
    } finally {
      await once(holder, 'exit')
      db.close()
    }
  })
})
