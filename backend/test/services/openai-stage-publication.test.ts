import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishOpenAiStageLedger } from '../../src/services/openai-stage-publication'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

afterEach(() => vi.restoreAllMocks())
const ledger = { phase: 'staged-not-activated', executable: false }

describe('atomic OpenAI stage ledger publication', () => {
  it.each(['partial-write', 'file-sync', 'directory-sync-before-publication'])(
    'does not expose a final ledger after %s failure',
    async (failure) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'openai-publish-')))
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(open).mockImplementation(async (...args) => {
        const file = await actual.open(...args)
        if (String(args[0]).includes('ledger.pending-')) {
          if (failure === 'partial-write') {
            const write = file.writeFile.bind(file)
            vi.spyOn(file, 'writeFile').mockImplementation(async () => {
              await write('{"partial":')
              throw new Error('synthetic-write-failure')
            })
          } else if (failure === 'file-sync')
            vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-fsync-failure'))
        } else if (String(args[0]) === root && failure === 'directory-sync-before-publication') {
          vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-directory-sync-failure'))
        }
        return file
      })
      try {
        await expect(publishOpenAiStageLedger(root, ledger)).rejects.toThrow('synthetic-')
        await expect(readFile(join(root, 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true })
      }
    },
  )

  it('reports published but unconfirmed durability after the final directory sync fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openai-publish-')))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args)
      if (String(args[0]) === root) {
        let published = false
        try {
          await actual.stat(join(root, 'ledger.json'))
          published = true
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (published) vi.spyOn(file, 'sync').mockRejectedValue(new Error('synthetic-directory-sync-failure'))
      }
      return file
    })
    try {
      await expect(publishOpenAiStageLedger(root, ledger)).rejects.toMatchObject({
        code: 'LEDGER_DURABILITY_UNCONFIRMED',
        published: true,
      })
      expect(JSON.parse(await readFile(join(root, 'ledger.json'), 'utf8'))).toEqual(ledger)
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
