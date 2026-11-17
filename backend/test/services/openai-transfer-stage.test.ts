import { open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageOpenAiTransfer } from '../../src/services/openai-transfer-stage'
import { decodeLegacyOpenAiStore } from '../../src/services/legacy-openai-store'
import { createOpenAiTransferFixture as fixture, passphrase } from '../helpers/openai-transfer-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
afterEach(() => vi.restoreAllMocks())

describe('stopped OpenAI transfer preparation', () => {
  it('propagates uncertain publication without writing a contradictory failed ledger', async () => {
    const f = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args)
      if (String(args[0]) === f.input.directory) {
        let published = false
        try {
          await actual.stat(join(f.input.directory, 'ledger.json'))
          published = true
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (published) vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-final-sync-failure'))
      }
      return file
    })
    try {
      await expect(stageOpenAiTransfer(f.input)).rejects.toMatchObject({
        code: 'LEDGER_DURABILITY_UNCONFIRMED',
        published: true,
      })
      const files = await readdir(f.input.directory)
      expect(files).toContain('ledger.json')
      expect(files).not.toContain('failed.json')
      expect(JSON.parse(await readFile(join(f.input.directory, 'ledger.json'), 'utf8'))).toMatchObject({
        phase: 'staged-not-activated',
        executable: false,
      })
      expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted)
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('retains encrypted source and prepares private inactive credentials without activating them', async () => {
    const f = await fixture()
    try {
      expect(decodeLegacyOpenAiStore(f.encrypted, passphrase)).toEqual(f.source)
      const ledger = await stageOpenAiTransfer(f.input)
      expect(ledger).toMatchObject({
        phase: 'staged-not-activated',
        credentialCount: 2,
        executable: false,
        refreshOwnershipTransferred: false,
      })
      expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted)
      expect(await readFile(join(f.input.directory, 'store.original.json'), 'utf8')).toBe(f.encrypted)
      const credentials = JSON.parse(await readFile(join(f.input.directory, 'credentials.pending.json'), 'utf8'))
      expect(credentials.map((entry: { activate: boolean }) => entry.activate)).toEqual([false, false])
      expect(credentials[0].value.access).toBe('synthetic-access-first')
      for (const name of await readdir(f.input.directory))
        expect((await stat(join(f.input.directory, name))).mode & 0o777).toBe(0o600)
      expect((await stat(f.input.directory)).mode & 0o777).toBe(0o700)
      expect(JSON.stringify(ledger)).not.toContain('synthetic-access')
      expect(JSON.stringify(ledger)).not.toContain(passphrase)
      await expect(stageOpenAiTransfer(f.input)).rejects.toThrow()
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('does not stage anything when old ownership has not stopped', async () => {
    const f = await fixture()
    try {
      await expect(
        stageOpenAiTransfer({
          ...f.input,
          assertQuiescent: async () => {
            throw new Error('synthetic-busy')
          },
        }),
      ).rejects.toThrow('synthetic-busy')
      expect(await readdir(f.root)).toEqual(['accounts.json'])
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('rejects a source changed during preparation without publishing completion', async () => {
    const f = await fixture()
    try {
      let checks = 0
      await expect(
        stageOpenAiTransfer({
          ...f.input,
          assertQuiescent: async () => {
            checks++
            if (checks === 2) await writeFile(f.input.sourceFile, f.encrypted + '\n')
          },
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
      expect(await readdir(f.input.directory)).not.toContain('ledger.json')
      expect(JSON.parse(await readFile(join(f.input.directory, 'failed.json'), 'utf8'))).toEqual({
        phase: 'failed',
        code: 'SOURCE_CHANGED',
        executable: false,
      })
      expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted + '\n')
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it.each([undefined, 'incorrect-key'])('rejects unavailable decryption without staging: %s', async (key) => {
    const f = await fixture()
    try {
      await expect(stageOpenAiTransfer({ ...f.input, passphrase: key })).rejects.toMatchObject({
        code: key === undefined ? 'STORE_LOCKED' : 'DECRYPTION_FAILED',
      })
      expect(await readdir(f.root)).toEqual(['accounts.json'])
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it.each(['store.original.json', 'credentials.pending.json', 'rotation.pending.json'])(
    'refuses a changed prepared file: %s',
    async (name) => {
      const f = await fixture()
      try {
        let checks = 0
        await expect(
          stageOpenAiTransfer({
            ...f.input,
            assertQuiescent: async () => {
              if (++checks === 2) await writeFile(join(f.input.directory, name), '{}')
            },
          }),
        ).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' })
        expect(await readdir(f.input.directory)).not.toContain('ledger.json')
        expect(JSON.parse(await readFile(join(f.input.directory, 'failed.json'), 'utf8'))).toEqual({
          phase: 'failed',
          code: 'CANDIDATE_CHANGED',
          executable: false,
        })
        expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted)
      } finally {
        await rm(f.root, { recursive: true })
      }
    },
  )
})
