import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiTransferFixture, passphrase } from '../helpers/openai-transfer-fixture'
import { mapLegacyOpenAiCredentials } from '../../src/services/openai-credential-transfer'
import { decodeLegacyOpenAiStore } from '../../src/services/legacy-openai-store'
import { restoreOpenAiStoreCopy } from '../../src/services/openai-rollback-copy'
import { publishOpenAiRollback } from '../../src/services/openai-rollback-publication'
import * as durability from '../../src/services/claude-database-files'
import * as publication from '../../src/services/claude-transfer-activate'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const value = await createOpenAiTransferFixture()
  roots.push(value.root)
  const credentials = mapLegacyOpenAiCredentials(value.source).credentials.map((entry) => ({
    ...entry,
    value: {
      ...entry.value,
      access: `new-access-${entry.label}`,
      refresh: `new-refresh-${entry.label}`,
    },
  }))
  const nativeText = JSON.stringify(credentials)
  const nativeSnapshotFile = join(value.root, 'native.json')
  await writeFile(nativeSnapshotFile, nativeText, { mode: 0o600 })
  return {
    ...value,
    input: {
      root: value.root,
      sourceFile: value.input.sourceFile,
      nativeSnapshotFile,
      sourceSha256: hash(value.encrypted),
      nativeSha256: hash(nativeText),
      passphrase,
      assertQuiescent: vi.fn(async () => {}),
    },
  }
}

describe('OpenAI rollback copy persistence', () => {
  it('publishes refreshed encrypted credentials from the verified rollback copy before legacy restart', async () => {
    const value = await fixture()
    const legacy = join(value.root, 'legacy')
    await mkdir(legacy, { mode: 0o700 })
    const target = join(legacy, 'accounts.json')
    await writeFile(target, value.encrypted, { mode: 0o600 })
    await restoreOpenAiStoreCopy(value.input)
    const input = {
      copyRoot: value.root,
      target,
      originalSha256: value.input.sourceSha256,
      nativeSha256: value.input.nativeSha256,
      assertQuiescent: value.input.assertQuiescent,
    }
    expect((await publishOpenAiRollback(input)).reused).toBe(false)
    expect(decodeLegacyOpenAiStore(await readFile(target, 'utf8'), passphrase)).toMatchObject({
      accounts: {
        first: {
          accessToken: 'new-access-first',
          refreshToken: 'new-refresh-first',
        },
      },
    })
    expect((await publishOpenAiRollback(input)).reused).toBe(true)
    await writeFile(target, 'concurrent-change')
    await expect(publishOpenAiRollback(input)).rejects.toThrow('OPENAI_ROLLBACK_PUBLICATION_UNVERIFIED')
    expect(await readFile(target, 'utf8')).toBe('concurrent-change')
  })

  it('does not publish a returned credential when its native evidence changes', async () => {
    const value = await fixture()
    const legacy = join(value.root, 'legacy')
    await mkdir(legacy, { mode: 0o700 })
    const target = join(legacy, 'accounts.json')
    await writeFile(target, value.encrypted, { mode: 0o600 })
    await restoreOpenAiStoreCopy(value.input)
    await writeFile(value.input.nativeSnapshotFile, 'changed')
    await expect(
      publishOpenAiRollback({
        copyRoot: value.root,
        target,
        originalSha256: value.input.sourceSha256,
        nativeSha256: value.input.nativeSha256,
        assertQuiescent: value.input.assertQuiescent,
      }),
    ).rejects.toThrow('OPENAI_ROLLBACK_PUBLICATION_UNVERIFIED')
    expect(await readFile(target, 'utf8')).toBe(value.encrypted)
  })

  it.each(['original.json', 'candidate.json', 'replacement'])(
    'resumes after partial %s write without modifying the source prematurely',
    async (phase) => {
      const value = await fixture()
      const originalWrite = publication.durableTransferText
      const write = vi.spyOn(publication, 'durableTransferText').mockImplementation(async (path, text) => {
        if (phase === 'replacement' ? path.includes('.rollback-pending-') : path.endsWith(`/${phase}`)) {
          await writeFile(path, text.slice(0, 12), {
            mode: 0o600,
            flag: 'wx',
          })
          throw new Error('partial write')
        }
        await originalWrite(path, text)
      })
      await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow('ROLLBACK_COPY_FAILED')
      expect(await readFile(value.input.sourceFile, 'utf8')).toBe(value.encrypted)
      const artifacts = await readdir(value.root)
      expect(
        artifacts.some((name) =>
          phase === 'replacement'
            ? name.includes('.rollback-pending-')
            : name.startsWith('openai-rollback-journal.pending-'),
        ),
      ).toBe(true)
      write.mockRestore()
      expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
        reused: false,
      })
      expect(await readFile(value.input.sourceFile, 'utf8')).not.toBe(value.encrypted)
    },
  )

  it('resumes after an interrupted intent publication without replacing the source early', async () => {
    const value = await fixture()
    const originalRecord = publication.durableTransferRecord
    const record = vi.spyOn(publication, 'durableTransferRecord').mockImplementation(async (path, data) => {
      if (path.endsWith('/intent.json')) {
        await writeFile(path, '{"version":', { mode: 0o600, flag: 'wx' })
        throw new Error('partial intent')
      }
      await originalRecord(path, data)
    })
    await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow('ROLLBACK_COPY_FAILED')
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(value.encrypted)
    expect(await readdir(value.root)).not.toContain('openai-rollback-journal')
    record.mockRestore()
    expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
      reused: false,
    })
    expect(await readFile(value.input.sourceFile, 'utf8')).not.toBe(value.encrypted)
  })

  it('rejects nested sources before a parent directory could be replaced', async () => {
    const value = await fixture()
    const nested = join(value.root, 'nested')
    await mkdir(nested, { mode: 0o700 })
    const sourceFile = join(nested, 'accounts.json')
    await writeFile(sourceFile, value.encrypted, { mode: 0o600 })
    await expect(restoreOpenAiStoreCopy({ ...value.input, sourceFile })).rejects.toThrow('INVALID_SCOPE')
    expect(value.input.assertQuiescent).not.toHaveBeenCalled()
    expect(await readFile(sourceFile, 'utf8')).toBe(value.encrypted)
  })

  it('refuses a source symlink introduced at the final stop check without writing outside the root', async () => {
    const value = await fixture()
    const other = await fixture()
    value.input.assertQuiescent.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      await rm(value.input.sourceFile)
      await symlink(other.input.sourceFile, value.input.sourceFile)
    })
    await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow()
    expect(await readFile(other.input.sourceFile, 'utf8')).toBe(other.encrypted)
    expect((await readdir(other.root)).filter((name) => name.includes('rollback'))).toEqual([])
  })
  it('returns snapshot tokens through encrypted copy replacement and replays without new ciphertext', async () => {
    const value = await fixture()
    expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
      reused: false,
    })
    const restored = await readFile(value.input.sourceFile, 'utf8')
    expect(decodeLegacyOpenAiStore(restored, passphrase)).toEqual({
      ...value.source,
      accounts: Object.fromEntries(
        Object.entries(value.source.accounts).map(([alias, account]) => [
          alias,
          {
            ...account,
            accessToken: `new-access-${alias}`,
            refreshToken: `new-refresh-${alias}`,
          },
        ]),
      ),
    })
    expect(await readFile(join(value.root, 'openai-rollback-journal/original.json'), 'utf8')).toBe(value.encrypted)
    expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
      reused: true,
    })
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(restored)
  })

  it('preserves source when the final stop check fails and resumes from the durable intent', async () => {
    const value = await fixture()
    value.input.assertQuiescent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('busy'))
    await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow('ROLLBACK_COPY_FAILED')
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(value.encrypted)
    const candidate = await readFile(join(value.root, 'openai-rollback-journal/candidate.json'), 'utf8')
    expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
      reused: false,
    })
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(candidate)
  })

  it('reconfirms durability on replay after replacement succeeded but final synchronization failed', async () => {
    const value = await fixture()
    const originalSync = durability.syncDatabasePath
    const sync = vi.spyOn(durability, 'syncDatabasePath').mockImplementation(async (path, directory) => {
      if (path === value.input.sourceFile) throw new Error('sync failed')
      await originalSync(path, directory)
    })
    await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow('ROLLBACK_COPY_FAILED')
    const restored = await readFile(value.input.sourceFile, 'utf8')
    expect(restored).not.toBe(value.encrypted)
    sync.mockRestore()
    expect(await restoreOpenAiStoreCopy(value.input)).toMatchObject({
      reused: true,
    })
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(restored)
  })

  it.each(['source', 'snapshot', 'candidate', 'intent'] as const)(
    'refuses changed %s on resume without overwriting source',
    async (kind) => {
      const value = await fixture()
      value.input.assertQuiescent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('busy'))
      await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow('ROLLBACK_COPY_FAILED')
      const paths = {
        source: value.input.sourceFile,
        snapshot: value.input.nativeSnapshotFile,
        candidate: join(value.root, 'openai-rollback-journal/candidate.json'),
        intent: join(value.root, 'openai-rollback-journal/intent.json'),
      }
      await writeFile(paths[kind], '{}')
      const before = await readFile(value.input.sourceFile, 'utf8')
      await expect(restoreOpenAiStoreCopy(value.input)).rejects.toThrow()
      expect(await readFile(value.input.sourceFile, 'utf8')).toBe(before)
    },
  )

  it('rejects a target outside the explicit copy root', async () => {
    const value = await fixture()
    const other = await fixture()
    await expect(restoreOpenAiStoreCopy({ ...value.input, root: other.root })).rejects.toThrow('INVALID_SCOPE')
    expect(await readFile(value.input.sourceFile, 'utf8')).toBe(value.encrypted)
  })
})
