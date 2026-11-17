import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { retireNativeAfterCredentialReturn } from '../../src/services/cutover-native-retirement'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([true, false])(
  'allows legacy restart only after credential return succeeds (failure=%s)',
  async (failReturn) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'credential-return-')))
    roots.push(root)
    const database = join(root, 'native.db')
    expect(
      spawnSync('/usr/bin/sqlite3', [database, 'CREATE TABLE preserved(id INTEGER); INSERT INTO preserved VALUES(1);'])
        .status,
    ).toBe(0)
    await chmod(database, 0o600)
    const before = await readFile(database)
    let legacyRunning = true
    let credentialsReturned = false
    const action = runCutoverSteps({
      persist: async () => {},
      steps: [
        {
          name: 'stop-legacy',
          forward: async () => {
            legacyRunning = false
          },
          rollback: async () => {
            legacyRunning = true
          },
        },
        {
          name: 'native-install',
          forward: async () => {},
          rollback: async () => {
            await retireNativeAfterCredentialReturn({
              retirement: {
                target: database,
                retireId: 'owned-return-check',
                assertQuiescent: async () => {
                  expect(legacyRunning).toBe(false)
                },
              },
              returnCredentials: async () => {
                expect(await readFile(database)).toEqual(before)
                if (failReturn) throw new Error('synthetic-return-failed')
                credentialsReturned = true
              },
            })
          },
        },
        {
          name: 'postflight',
          forward: async () => {
            throw new Error('synthetic-postflight-failed')
          },
          rollback: async () => {},
        },
      ],
    })
    await expect(action).rejects.toMatchObject({
      rollback: failReturn ? 'unverified' : 'verified',
    })
    expect(legacyRunning).toBe(!failReturn)
    expect(credentialsReturned).toBe(!failReturn)
    if (failReturn) {
      expect(await readFile(database)).toEqual(before)
      expect(await readdir(root)).toEqual(['native.db'])
    } else {
      expect(await readFile(database + '.retired-owned-return-check')).toEqual(before)
      await expect(readFile(database)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  },
)
