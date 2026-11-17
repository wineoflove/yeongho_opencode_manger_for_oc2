import { createHash } from 'node:crypto'
import { open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageOpenAiTransfer } from '../../src/services/openai-transfer-stage'
import { validateOpenAiTransferCandidate } from '../../src/services/openai-transfer-candidate'
import { createOpenAiTransferFixture as fixture } from '../helpers/openai-transfer-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
afterEach(() => vi.restoreAllMocks())

describe('final OpenAI candidate validation', () => {
  it.each(['ledger', 'credentials', 'rotation'])('does not expose malformed %s contents in errors', async (kind) => {
    const f = await fixture()
    try {
      const ledger = await stageOpenAiTransfer(f.input)
      const text = '{"private":"synthetic-secret-sentinel"'
      switch (kind) {
        case 'ledger':
          await writeFile(join(f.input.directory, 'ledger.json'), text)
          break
        case 'credentials':
          await writeFile(join(f.input.directory, 'credentials.pending.json'), text)
          await writeFile(
            join(f.input.directory, 'ledger.json'),
            JSON.stringify({
              ...ledger,
              credentialFileSha256: createHash('sha256').update(text).digest('hex'),
            }),
          )
          break
        case 'rotation':
          await writeFile(join(f.input.directory, 'rotation.pending.json'), text)
          break
        default:
          throw new Error('unexpected_case')
      }
      await expect(validateOpenAiTransferCandidate(f.input)).rejects.toMatchObject({
        code: 'INVALID_STAGE',
        message: 'INVALID_STAGE',
      })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('reconfirms an intact ledger after a publication directory fsync failure', async () => {
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
        if (published) vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-publication-sync-failure'))
      }
      return file
    })
    try {
      await expect(stageOpenAiTransfer(f.input)).rejects.toMatchObject({
        code: 'LEDGER_DURABILITY_UNCONFIRMED',
      })
      vi.mocked(open).mockImplementation(actual.open)
      await expect(validateOpenAiTransferCandidate(f.input)).resolves.toMatchObject({
        durabilityReconfirmed: true,
        executable: false,
        refreshOwnershipTransferred: false,
      })
      expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted)
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('revalidates staged credentials and durability without activating or changing source bytes', async () => {
    const f = await fixture()
    try {
      const ledger = await stageOpenAiTransfer(f.input)
      const files = await readdir(f.input.directory)
      const result = await validateOpenAiTransferCandidate(f.input)
      expect(result).toMatchObject({
        phase: 'validated-not-activated',
        executable: false,
        refreshOwnershipTransferred: false,
        durabilityReconfirmed: true,
        sourceSha256: ledger.sourceSha256,
      })
      expect(result.credentials.map((entry) => entry.activate)).toEqual([false, false])
      expect(result.credentials[0]?.value.access).toBe('synthetic-access-first')
      expect(await readFile(f.input.sourceFile, 'utf8')).toBe(f.encrypted)
      expect(await readdir(f.input.directory)).toEqual(files)
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it.each(['source', 'archived-source', 'credentials', 'rotation', 'ledger', 'failed-marker'])(
    'refuses a changed stage: %s',
    async (change) => {
      const f = await fixture()
      try {
        const ledger = await stageOpenAiTransfer(f.input)
        switch (change) {
          case 'source':
            await writeFile(f.input.sourceFile, f.encrypted + '\n')
            break
          case 'archived-source':
            await writeFile(join(f.input.directory, 'store.original.json'), '{}')
            break
          case 'credentials':
            await writeFile(join(f.input.directory, 'credentials.pending.json'), '[]')
            break
          case 'rotation':
            await writeFile(join(f.input.directory, 'rotation.pending.json'), '{}')
            break
          case 'ledger':
            await writeFile(join(f.input.directory, 'ledger.json'), JSON.stringify({ ...ledger, credentialCount: 1 }))
            break
          case 'failed-marker':
            await writeFile(join(f.input.directory, 'failed.json'), '{}')
            break
          default:
            throw new Error('unexpected_case')
        }
        await expect(validateOpenAiTransferCandidate(f.input)).rejects.toThrow()
      } finally {
        await rm(f.root, { recursive: true })
      }
    },
  )

  it('rejects altered credentials even when the candidate hash is also replaced', async () => {
    const f = await fixture()
    try {
      const ledger = await stageOpenAiTransfer(f.input)
      const text = '[]'
      await writeFile(join(f.input.directory, 'credentials.pending.json'), text)
      await writeFile(
        join(f.input.directory, 'ledger.json'),
        JSON.stringify({
          ...ledger,
          credentialFileSha256: createHash('sha256').update(text).digest('hex'),
        }),
      )
      await expect(validateOpenAiTransferCandidate(f.input)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('rejects expired execution budget and unproven quiescence', async () => {
    const f = await fixture()
    try {
      await stageOpenAiTransfer(f.input)
      await expect(
        validateOpenAiTransferCandidate({
          ...f.input,
          assertQuiescent: async () => {
            throw new Error('synthetic-busy')
          },
        }),
      ).rejects.toThrow('synthetic-busy')
      vi.spyOn(Date, 'now').mockReturnValue(f.source.accounts.first.expiresAt - 300000)
      await expect(validateOpenAiTransferCandidate(f.input)).rejects.toMatchObject({
        code: 'INSUFFICIENT_TOKEN_LIFETIME',
      })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('rechecks source bytes after the final quiescence check', async () => {
    const f = await fixture()
    try {
      await stageOpenAiTransfer(f.input)
      let checks = 0
      await expect(
        validateOpenAiTransferCandidate({
          ...f.input,
          assertQuiescent: async () => {
            if (++checks === 2) await writeFile(f.input.sourceFile, f.encrypted + '\n')
          },
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('does not validate a candidate when ledger fsync fails', async () => {
    const f = await fixture()
    try {
      await stageOpenAiTransfer(f.input)
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(open).mockImplementation(async (...args) => {
        const file = await actual.open(...args)
        if (String(args[0]) === join(f.input.directory, 'ledger.json'))
          vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-sync-error'))
        return file
      })
      await expect(validateOpenAiTransferCandidate(f.input)).rejects.toMatchObject({ code: 'DURABILITY_UNCONFIRMED' })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
})
