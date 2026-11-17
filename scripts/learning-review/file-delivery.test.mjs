import { test, expect } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishExactReport } from './report-delivery.mjs'

test.each(['normal', 'symlink-directory', 'hardlink-report'])(
  'file delivery preserves scope and content: %s',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'report-delivery-')))
    try {
      const store = join(root, 'store')
      const reviews = join(store, 'reviews')
      const outside = join(root, 'outside')
      await mkdir(reviews, { recursive: true, mode: 0o700 })
      await mkdir(outside, { mode: 0o700 })
      const delivered = join(reviews, 'delivered')
      if (mode === 'symlink-directory') await symlink(outside, delivered)
      else await mkdir(delivered, { mode: 0o700 })
      if (mode === 'hardlink-report') {
        await writeFile(join(outside, 'original.md'), 'report', {
          mode: 0o600,
        })
        await link(join(outside, 'original.md'), join(delivered, 'msg_fixture.md'))
      }
      const config = { store, delivery: 'file' }
      if (mode === 'normal') {
        await publishExactReport(config, 'msg_fixture', 'report')
        await publishExactReport(config, 'msg_fixture', 'report')
        await expect(publishExactReport(config, 'msg_fixture', 'changed')).rejects.toThrow('Report ID content mismatch')
        expect(await readFile(join(delivered, 'msg_fixture.md'), 'utf8')).toBe('report')
      } else {
        await expect(publishExactReport(config, 'msg_fixture', 'report')).rejects.toThrow('Report path rejected')
        expect(await readdir(outside)).toEqual(mode === 'hardlink-report' ? ['original.md'] : [])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
