import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, link, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNativeDatabase, retireNativeDatabase } from '../../src/services/native-database-install'

let root: string
let staged: string
let target: string
let stagedSha256: string
const quiescent = async () => {}

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const count = (path: string) =>
  spawnSync('/usr/bin/sqlite3', [path, 'SELECT count(*) FROM session;'], {
    encoding: 'utf8',
  }).stdout.trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-install-'))
  await chmod(root, 0o700)
  staged = join(root, 'staged.db')
  target = join(root, 'opencode-ocm-pool.db')
  expect(
    spawnSync('/usr/bin/sqlite3', [staged, 'CREATE TABLE session(id TEXT); INSERT INTO session VALUES (1),(2),(3);'])
      .status,
  ).toBe(0)
  await chmod(staged, 0o600)
  stagedSha256 = await sha256(staged)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('native database installation', () => {
  it('installs a verified copy without leaving temporary files or changing the staged source', async () => {
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
      }),
    ).resolves.toEqual({
      path: target,
      sha256: stagedSha256,
      state: 'installed',
      unrelatedTemporaryFiles: 0,
    })
    expect((await installNativeDatabase({ staged, stagedSha256, target, assertQuiescent: quiescent })).state).toBe(
      'reused',
    )
    expect(await sha256(target)).toBe(stagedSha256)
    expect(await sha256(staged)).toBe(stagedSha256)
    expect(count(target)).toBe('3')
    expect((await readdir(root)).filter((name) => name.includes('installing'))).toEqual([])
  })

  it('never replaces an existing database or one with leftover sidecars', async () => {
    await writeFile(target, 'existing', { mode: 0o600 })
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_PRESENT' })
    expect(await readFile(target, 'utf8')).toBe('existing')
    await rm(target)
    await writeFile(target + '-wal', 'stale', { mode: 0o600 })
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_PRESENT' })
    expect(await readdir(root)).not.toContain('opencode-ocm-pool.db')
  })

  it('completes an install interrupted after linking and leaves unrelated temporary files alone', async () => {
    await installNativeDatabase({ staged, stagedSha256, target, assertQuiescent: quiescent })
    const interrupted = join(root, '.opencode-ocm-pool.db.installing-interrupted')
    await link(target, interrupted)
    await writeFile(join(root, '.opencode-ocm-pool.db.installing-unrelated'), 'partial', { mode: 0o600 })
    expect((await lstat(target)).nlink).toBe(2)
    const resumed = await installNativeDatabase({ staged, stagedSha256, target, assertQuiescent: quiescent })
    expect(resumed).toMatchObject({ state: 'reused', unrelatedTemporaryFiles: 1 })
    expect((await lstat(target)).nlink).toBe(1)
    expect(await readdir(root)).toContain('.opencode-ocm-pool.db.installing-unrelated')
    expect(await readdir(root)).not.toContain('.opencode-ocm-pool.db.installing-interrupted')
  })

  it('refuses a changed, held, sidecar-bearing or non-quiescent staged database', async () => {
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256: '0'.repeat(64),
        target,
        assertQuiescent: quiescent,
      }),
    ).rejects.toMatchObject({ code: 'STAGED_CHANGED' })
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: async () => {
          throw new Error('service_running')
        },
      }),
    ).rejects.toThrow('service_running')
    const holder = spawn('/usr/bin/sqlite3', [staged], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const closed = once(holder, 'close')
    holder.stdin.write("SELECT 'ready';\n")
    await once(holder.stdout, 'data')
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_PRESENT' })
    holder.stdin.end()
    await closed
    await writeFile(staged + '-journal', '', { mode: 0o600 })
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
      }),
    ).rejects.toMatchObject({ code: 'SIDECAR_PRESENT' })
    expect(
      (await readdir(root)).filter((name) => name.startsWith('opencode-ocm-pool') || name.includes('installing')),
    ).toEqual([])
  })

  it('accepts a group-writable directory only with explicit opt-in and never an other-writable one', async () => {
    await chmod(root, 0o775)
    await expect(
      installNativeDatabase({ staged, stagedSha256, target, assertQuiescent: quiescent }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      installNativeDatabase({
        staged,
        stagedSha256,
        target,
        assertQuiescent: quiescent,
        allowGroupWritableDirectory: true,
      }),
    ).resolves.toMatchObject({ sha256: stagedSha256 })
    await expect(retireNativeDatabase({ target, assertQuiescent: quiescent })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await chmod(root, 0o777)
    await expect(
      retireNativeDatabase({ target, assertQuiescent: quiescent, allowGroupWritableDirectory: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await chmod(root, 0o775)
    const retired = await retireNativeDatabase({
      target,
      assertQuiescent: quiescent,
      allowGroupWritableDirectory: true,
    })
    expect(retired.retired.map((entry) => entry.from)).toEqual([target])
    await chmod(root, 0o700)
  })
})

describe('native database retirement', () => {
  it('moves the database before its sidecars, is repeatable and leaves no live file', async () => {
    await installNativeDatabase({
      staged,
      stagedSha256,
      target,
      assertQuiescent: quiescent,
    })
    await writeFile(target + '-wal', 'wal', { mode: 0o600 })
    await writeFile(target + '-shm', 'shm', { mode: 0o600 })
    const first = await retireNativeDatabase({
      target,
      assertQuiescent: quiescent,
    })
    expect(first.retired.map((entry) => entry.from)).toEqual([target, target + '-wal', target + '-shm'])
    for (const entry of first.retired) expect(entry.to.startsWith(entry.from + '.retired-')).toBe(true)
    expect(await sha256(first.retired[0]?.to ?? '')).toBe(stagedSha256)
    expect((await readdir(root)).filter((name) => /^opencode-ocm-pool\.db(-wal|-shm)?$/.test(name))).toEqual([])
    await expect(retireNativeDatabase({ target, assertQuiescent: quiescent })).resolves.toEqual({ retired: [] })
  })

  it('uses a caller-provided retire identifier and refuses to overwrite an earlier retirement', async () => {
    await installNativeDatabase({ staged, stagedSha256, target, assertQuiescent: quiescent })
    await writeFile(target + '-wal', 'wal', { mode: 0o600 })
    await writeFile(target + '.retired-cutover-0001', 'earlier', { mode: 0o600 })
    await expect(
      retireNativeDatabase({ target, assertQuiescent: quiescent, retireId: 'cutover-0001' }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' })
    expect(await sha256(target)).toBe(stagedSha256)
    const retired = await retireNativeDatabase({ target, assertQuiescent: quiescent, retireId: 'cutover-0002' })
    expect(retired.retired.map((entry) => entry.to)).toEqual([
      target + '.retired-cutover-0002',
      target + '-wal.retired-cutover-0002',
    ])
    await expect(
      retireNativeDatabase({ target, assertQuiescent: quiescent, retireId: 'BAD ID' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('moves leftover sidecars when the database itself is already gone', async () => {
    await writeFile(target + '-wal', 'wal', { mode: 0o600 })
    const result = await retireNativeDatabase({
      target,
      assertQuiescent: quiescent,
    })
    expect(result.retired.map((entry) => entry.from)).toEqual([target + '-wal'])
  })

  it('moves nothing while the database is held', async () => {
    await installNativeDatabase({
      staged,
      stagedSha256,
      target,
      assertQuiescent: quiescent,
    })
    const holder = spawn('/usr/bin/sqlite3', [target], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const closed = once(holder, 'close')
    holder.stdin.write("SELECT 'ready';\n")
    await once(holder.stdout, 'data')
    try {
      await expect(retireNativeDatabase({ target, assertQuiescent: quiescent })).rejects.toMatchObject({
        code: 'TARGET_CHANGED',
      })
      expect(await sha256(target)).toBe(stagedSha256)
    } finally {
      holder.stdin.end()
      await closed
    }
  })
})
