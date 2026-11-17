import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageClaudeTransfer } from '../../src/services/claude-transfer-stage'
import { activateClaudeTransfer } from '../../src/services/claude-transfer-activate'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'transfer-activate-'))
  const credential = {
    type: 'oauth',
    access: 'fixture-access',
    refresh: 'fixture-refresh',
    expires: 1800000000000,
  }
  const source = JSON.stringify({
    version: 1,
    paused: false,
    cursor: 0,
    blockedRequests: [],
    accounts: [
      {
        id: 'main',
        label: 'fixture',
        enabled: true,
        status: 'ok',
        cooldownUntil: 0,
        credentials: credential,
      },
    ],
  })
  const input = {
    poolFile: join(root, 'pool.json'),
    nativeAuthFile: join(root, 'auth.json'),
    stagingDirectory: join(root, 'staged'),
    targetAuthDirectory: join(root, 'target'),
    assertQuiescent: async () => {},
  }
  await writeFile(input.poolFile, source, { mode: 0o600 })
  await writeFile(input.nativeAuthFile, JSON.stringify({ anthropic: credential }), { mode: 0o600 })
  await mkdir(input.targetAuthDirectory, { mode: 0o700 })
  await stageClaudeTransfer({
    ...input,
    identities: { main: '00000000-0000-4000-8000-000000000001' },
  })
  return { input, root, source }
}

describe('stopped credential directory activation', () => {
  it('installs only verified credentials and retains both original files and the previous directory', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.input.targetAuthDirectory, 'kv.db'), 'fixture-state')
      expect(await activateClaudeTransfer(f.input)).toEqual({
        phase: 'files-installed-services-stopped',
        imported: 1,
      })
      expect(await readdir(f.input.targetAuthDirectory)).toEqual(['legacy-main.json'])
      expect(await readFile(join(f.input.stagingDirectory, 'auth-directory.before/kv.db'), 'utf8')).toBe(
        'fixture-state',
      )
      expect(await readFile(f.input.poolFile, 'utf8')).toBe(f.source)
      await expect(activateClaudeTransfer(f.input)).rejects.toThrow()
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('restores the old directory when quiescence is lost between directory moves', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.input.targetAuthDirectory, 'kv.db'), 'before')
      let calls = 0
      await expect(
        activateClaudeTransfer({
          ...f.input,
          assertQuiescent: async () => {
            if (++calls === 3) throw new Error('busy')
          },
        }),
      ).rejects.toThrow()
      expect(await readdir(f.input.targetAuthDirectory)).toEqual(['kv.db'])
      expect(await readFile(join(f.input.targetAuthDirectory, 'kv.db'), 'utf8')).toBe('before')
      expect(await readdir(join(f.input.stagingDirectory, 'pending-auth'))).toEqual(['legacy-main.json'])
      expect(JSON.parse(await readFile(join(f.input.stagingDirectory, 'activation-restored.json'), 'utf8')).phase).toBe(
        'previous-directory-restored',
      )
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('rejects modified staged tokens before moving the active directory', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.input.stagingDirectory, 'pending-auth/legacy-main.json'), '{}')
      await expect(activateClaudeTransfer(f.input)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
      })
      expect(await readdir(f.input.targetAuthDirectory)).toEqual([])
      expect(await readdir(f.input.stagingDirectory)).not.toContain('activation-intent.json')
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
})
