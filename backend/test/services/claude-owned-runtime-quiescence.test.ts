import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertDatabaseFilesUnheld,
  captureProcessIdentities,
  survivingIdentities,
} from '../../src/services/claude-transfer-quiescence'

describe('owned runtime quiescence', () => {
  it('binds process identity to start time so a reused pid is not treated as the original', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    const closed = once(child, 'close')
    try {
      if (!child.pid) throw new Error('missing_child')
      const [identity] = captureProcessIdentities([child.pid])
      if (!identity) throw new Error('missing_identity')
      expect(survivingIdentities([identity])).toEqual([identity])
      expect(survivingIdentities([{ pid: identity.pid, started: 'Thu Jan  1 00:00:00 1970' }])).toEqual([])
      child.kill('SIGTERM')
      await closed
      expect(survivingIdentities([identity])).toEqual([])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })

  it('rejects a database whose main file or sidecars are still held and accepts it after the holder exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owned-quiescence-'))
    const database = join(root, 'data.db')
    const holder = spawn('/usr/bin/sqlite3', [database], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const closed = once(holder, 'close')
    try {
      holder.stdin.write(
        "PRAGMA journal_mode=WAL;\nCREATE TABLE value(x);\nINSERT INTO value VALUES (1);\nSELECT 'ready';\n",
      )
      await once(holder.stdout, 'data')
      await expect(assertDatabaseFilesUnheld([database])).rejects.toMatchObject({ code: 'PROCESS_PRESENT' })
      holder.stdin.end()
      await closed
      await expect(assertDatabaseFilesUnheld([database])).resolves.toBeUndefined()
      await expect(assertDatabaseFilesUnheld([join(root, 'missing.db')])).rejects.toMatchObject({
        code: 'INVALID_SCOPE',
      })
      await expect(assertDatabaseFilesUnheld(['relative.db'])).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  })
})
