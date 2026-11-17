import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { restoreClaudeDatabases } from '../../src/services/claude-database-restore'

describe('paired database restore filesystem admission', () => {
  it('rejects a different target filesystem before creating a restore directory or modifying either target', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'restore-devices-')))
    const second = join(root, 'second-volume')
    await fs.mkdir(second)
    const targets = [join(root, 'manager.db'), join(second, 'opencode.db')]
    await Promise.all(targets.map((path) => fs.writeFile(path, 'unchanged', { mode: 0o600 })))
    try {
      expect((await fs.lstat('/dev')).dev).not.toBe((await fs.lstat(root)).dev)
      await expect(
        restoreClaudeDatabases({
          directory: join(root, 'restore'),
          databases: [
            {
              name: 'manager',
              target: targets[0] ?? '',
              backup: join(root, 'manager.backup'),
              backupSha256: '0'.repeat(64),
              targetSha256: '1'.repeat(64),
            },
            {
              name: 'opencode',
              target: '/dev/ocm-restore-never-created.db',
              backup: join(root, 'opencode.backup'),
              backupSha256: '0'.repeat(64),
              targetSha256: '1'.repeat(64),
            },
          ],
          assertQuiescent: async () => {},
          verifyDatabase: async () => {},
        }),
      ).rejects.toMatchObject({ code: 'FILESYSTEM_MISMATCH' })
      for (const path of targets) expect(await fs.readFile(path, 'utf8')).toBe('unchanged')
      await expect(fs.stat(join(root, 'restore'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await fs.rm(root, { recursive: true })
    }
  })
})
