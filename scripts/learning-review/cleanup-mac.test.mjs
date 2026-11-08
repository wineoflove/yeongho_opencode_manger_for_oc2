import { expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup } from './cleanup.mjs'

it('retains imported historical sessions before the Mac activation time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-review-cleanup-'))
  mkdirSync(join(root, 'state'))
  const managerDb = join(root, 'manager.sqlite')
  const db = new Database(managerDb)
  db.exec(
    'CREATE TABLE schedule_jobs(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE schedule_runs(id INTEGER,job_id INTEGER,status TEXT,finished_at INTEGER,session_id TEXT,response_text TEXT);',
  )
  db.query('INSERT INTO schedule_jobs VALUES(?,?)').run(5, 'daily')
  db.query('INSERT INTO schedule_runs VALUES(?,?,?,?,?,?)').run(
    1,
    5,
    'completed',
    1000,
    'ses_imported',
    JSON.stringify({ status: 'done', mode: 'daily', batch: 'abcdef0123456789abcdef01' }),
  )
  db.close()
  const send = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('historical-session-access')
  })
  try {
    expect(
      await cleanup({
        managerDb,
        store: root,
        directory: '/fixture',
        delivery: 'prompt',
        feedbackSession: 'ses_feedback',
        cleanupJobIds: [5, 6],
        cleanupEnabledAt: 2000,
      }),
    ).toEqual({ removed: [] })
    expect(send).not.toHaveBeenCalled()
  } finally {
    send.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
