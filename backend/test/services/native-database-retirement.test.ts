import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { retireNativeDatabase } from '../../src/services/native-database-install'

it.each([false, true])(
  'resumes after main retirement only with matching sidecar identity (changed=%s)',
  async (changed) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-retirement-')))
    try {
      const target = join(root, 'native.db')
      const state = join(root, 'state')
      await mkdir(state, { mode: 0o700 })
      await writeFile(target, 'synthetic-database', { mode: 0o600 })
      await writeFile(target + '-wal', 'synthetic-wal', { mode: 0o600 })
      const input = {
        target,
        retireId: 'partial-retirement',
        retirementDirectory: state,
      }
      let calls = 0
      await expect(
        retireNativeDatabase({
          ...input,
          assertQuiescent: async () => {
            if (++calls === 3) throw new Error('synthetic-main-renamed')
          },
        }),
      ).rejects.toThrow('synthetic-main-renamed')
      expect(await readFile(target + '.retired-partial-retirement', 'utf8')).toBe('synthetic-database')
      expect(await readFile(target + '-wal', 'utf8')).toBe('synthetic-wal')
      if (changed) {
        await writeFile(target + '-wal', 'replaced-wal')
        await expect(retireNativeDatabase({ ...input, assertQuiescent: async () => {} })).rejects.toThrow(
          'NATIVE_RETIREMENT_UNVERIFIED',
        )
        expect(await readFile(target + '-wal', 'utf8')).toBe('replaced-wal')
      } else {
        const result = await retireNativeDatabase({
          ...input,
          assertQuiescent: async () => {},
        })
        expect(result.retired).toHaveLength(2)
        expect(await readFile(target + '-wal.retired-partial-retirement', 'utf8')).toBe('synthetic-wal')
        expect(
          await retireNativeDatabase({
            ...input,
            assertQuiescent: async () => {},
          }),
        ).toEqual(result)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
