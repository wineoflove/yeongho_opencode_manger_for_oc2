import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyConfigCandidate, restoreConfigOriginal } from '../../src/services/config-file-swap'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const original = '{\n  // user comment\n  "model": "original"\n}\n'
const candidate = '{\n  "model": "candidate"\n}\n'
let root: string
let configDirectory: string
let target: string
let archiveDirectory: string
const quiescent = async () => {}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'config-swap-')))
  configDirectory = join(root, 'config')
  archiveDirectory = join(root, 'archive')
  await mkdir(configDirectory, { mode: 0o700 })
  await mkdir(archiveDirectory, { mode: 0o700 })
  target = join(configDirectory, 'opencode.json')
  await writeFile(target, original, { mode: 0o600 })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const scope = () => ({
  target,
  originalSha256: sha256(original),
  archiveDirectory,
  assertQuiescent: quiescent,
})

describe('hash-bound configuration swap', () => {
  it.each([0o600, 0o664])('applies, replays, restores and keeps mode %o without leftovers', async (mode) => {
    await chmod(target, mode)
    const applied = await applyConfigCandidate({
      ...scope(),
      candidate,
      candidateSha256: sha256(candidate),
    })
    expect(applied.state).toBe('applied')
    expect(await readFile(target, 'utf8')).toBe(candidate)
    expect((await stat(target)).mode & 0o777).toBe(mode)
    expect(await readFile(applied.archive, 'utf8')).toBe(original)
    expect(
      (
        await applyConfigCandidate({
          ...scope(),
          candidate,
          candidateSha256: sha256(candidate),
        })
      ).state,
    ).toBe('reused')
    expect(
      (
        await restoreConfigOriginal({
          ...scope(),
          candidateSha256: sha256(candidate),
        })
      ).state,
    ).toBe('restored')
    expect(await readFile(target, 'utf8')).toBe(original)
    expect((await stat(target)).mode & 0o777).toBe(mode)
    expect(
      (
        await restoreConfigOriginal({
          ...scope(),
          candidateSha256: sha256(candidate),
        })
      ).state,
    ).toBe('already-original')
    expect((await readdir(configDirectory)).filter((name) => name.includes('swap'))).toEqual([])
  })

  it('refuses a changed source before writing and a runtime-modified candidate on restore', async () => {
    await writeFile(target, original + ' ')
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(await readFile(target, 'utf8')).toBe(original + ' ')
    expect(await readdir(archiveDirectory)).toEqual([])
    await writeFile(target, original)
    await applyConfigCandidate({
      ...scope(),
      candidate,
      candidateSha256: sha256(candidate),
    })
    await writeFile(target, candidate + '\n')
    await expect(restoreConfigOriginal({ ...scope(), candidateSha256: sha256(candidate) })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    })
    expect(await readFile(target, 'utf8')).toBe(candidate + '\n')
  })

  it('preserves edits made during the final rollback quiescence check', async () => {
    await applyConfigCandidate({
      ...scope(),
      candidate,
      candidateSha256: sha256(candidate),
    })
    const concurrent = '{"model":"user-updated"}\n'
    let checks = 0
    await expect(
      restoreConfigOriginal({
        ...scope(),
        candidateSha256: sha256(candidate),
        assertQuiescent: async () => {
          checks += 1
          if (checks === 2) await writeFile(target, concurrent)
        },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(await readFile(target, 'utf8')).toBe(concurrent)
  })

  it('requires explicit opt-in for a group-writable directory and a private archive', async () => {
    await chmod(configDirectory, 0o775)
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await chmod(archiveDirectory, 0o750)
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
        allowGroupWritableDirectory: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await chmod(archiveDirectory, 0o700)
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
        allowGroupWritableDirectory: true,
      }),
    ).resolves.toMatchObject({ state: 'applied' })
    await chmod(configDirectory, 0o777)
    await expect(
      restoreConfigOriginal({
        ...scope(),
        candidateSha256: sha256(candidate),
        allowGroupWritableDirectory: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await chmod(configDirectory, 0o700)
  })

  it('rejects a mismatched candidate hash and keeps the original when quiescence is lost', async () => {
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256('other'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    let calls = 0
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
        assertQuiescent: async () => {
          if (++calls === 2) throw new Error('service_started')
        },
      }),
    ).rejects.toThrow('service_started')
    expect(await readFile(target, 'utf8')).toBe(original)
  })

  it('refuses an archive whose content conflicts with the recorded original', async () => {
    await writeFile(join(archiveDirectory, `opencode.json.${sha256(original)}.original`), 'tampered', { mode: 0o600 })
    await expect(
      applyConfigCandidate({
        ...scope(),
        candidate,
        candidateSha256: sha256(candidate),
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_CONFLICT' })
    expect(await readFile(target, 'utf8')).toBe(original)
  })
})
