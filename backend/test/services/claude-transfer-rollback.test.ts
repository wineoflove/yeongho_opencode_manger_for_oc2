import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { stageClaudeTransfer } from '../../src/services/claude-transfer-stage'
import { activateClaudeTransfer } from '../../src/services/claude-transfer-activate'
import { rollbackClaudeTransfer } from '../../src/services/claude-transfer-rollback'
import { ClaudeProxyGate } from '../../src/services/claude-proxy-gate'
import { resumeClaudeRollback } from '../../src/services/claude-transfer-resume'

async function fixture(nativeAuthMode: 'synchronize-main' | 'preserve-anchor' = 'synchronize-main') {
  const root = await mkdtemp(join(tmpdir(), 'transfer-return-'))
  const credentials = {
    type: 'oauth',
    access: 'old-access',
    refresh: 'old-refresh',
    expires: 1800000000000,
  }
  const pool = {
    version: 1,
    cursor: 0,
    paused: false,
    blockedRequests: [],
    accounts: [
      {
        id: 'main',
        label: 'fixture',
        enabled: true,
        status: 'ok',
        cooldownUntil: 0,
        credentials,
      },
    ],
  }
  const auth = {
    anthropic:
      nativeAuthMode === 'preserve-anchor'
        ? {
            ...credentials,
            access: 'native-anchor',
            refresh: 'native-anchor-refresh',
          }
        : credentials,
    openai: { type: 'api', key: 'fixture-preserved' },
  }
  const input = {
    poolFile: join(root, 'pool'),
    nativeAuthFile: join(root, 'auth'),
    stagingDirectory: join(root, 'stage'),
    targetAuthDirectory: join(root, 'target'),
    gateDirectory: join(root, 'gate'),
    assertQuiescent: async () => {},
    nativeAuthMode,
  }
  await writeFile(input.poolFile, JSON.stringify(pool), { mode: 0o600 })
  await writeFile(input.nativeAuthFile, JSON.stringify(auth, null, 2), {
    mode: 0o600,
  })
  await mkdir(input.targetAuthDirectory, { mode: 0o700 })
  await ClaudeProxyGate.initialize(input.gateDirectory)
  await stageClaudeTransfer({
    ...input,
    identities: { main: '00000000-0000-4000-8000-000000000001' },
  })
  await activateClaudeTransfer(input)
  const file = join(input.targetAuthDirectory, 'legacy-main.json')
  const proxy = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(
    file,
    JSON.stringify({
      ...proxy,
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
    }),
  )
  return { root, input, auth }
}

describe('latest-token rollback filesystem boundary', () => {
  it('retries prepared return files before publishing rollback intent after a write failure', async () => {
    const f = await fixture('preserve-anchor')
    try {
      const authReturn = join(f.input.stagingDirectory, 'auth.return.json')
      await mkdir(authReturn)
      await expect(rollbackClaudeTransfer(f.input)).rejects.toThrow()
      expect(await readdir(f.input.stagingDirectory)).not.toContain('rollback-intent.json')
      expect(JSON.parse(await readFile(f.input.poolFile, 'utf8')).accounts[0].credentials.refresh).toBe('old-refresh')
      await rm(authReturn, { recursive: true })
      await rollbackClaudeTransfer(f.input)
      expect(JSON.parse(await readFile(f.input.poolFile, 'utf8')).accounts[0].credentials.refresh).toBe(
        'rotated-refresh',
      )
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('keeps the verified non-owning native anchor byte-for-byte while returning rotated pool tokens', async () => {
    const f = await fixture('preserve-anchor')
    try {
      const nativeBefore = await readFile(f.input.nativeAuthFile, 'utf8')
      await rollbackClaudeTransfer(f.input)
      expect(await readFile(f.input.nativeAuthFile, 'utf8')).toBe(nativeBefore)
      expect(JSON.parse(await readFile(f.input.poolFile, 'utf8')).accounts[0].credentials.refresh).toBe(
        'rotated-refresh',
      )
      expect(await resumeClaudeRollback(f.input)).toEqual({
        phase: 'latest-credentials-returned-services-stopped',
        written: 0,
      })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it.each(['resume', 'unknown-legacy', 'proxy-changed', 'candidate-changed'])(
    'checks partial recovery before writes: %s',
    async (mode) => {
      const f = await fixture()
      try {
        let calls = 0
        await expect(
          rollbackClaudeTransfer({
            ...f.input,
            assertQuiescent: async () => {
              if (++calls === 3) throw new Error('interrupted')
            },
          }),
        ).rejects.toThrow()
        switch (mode) {
          case 'resume':
            break
          case 'unknown-legacy':
            await writeFile(f.input.nativeAuthFile, '{"unexpected":true}')
            break
          case 'proxy-changed':
            await writeFile(join(f.input.targetAuthDirectory, 'legacy-main.json'), '{}')
            break
          case 'candidate-changed':
            await writeFile(join(f.input.stagingDirectory, 'auth.return.json'), '{}')
            break
          default:
            throw new Error('unexpected_case')
        }
        if (mode === 'resume') {
          const poolBefore = await readFile(f.input.poolFile, 'utf8')
          expect(await resumeClaudeRollback(f.input)).toEqual({
            phase: 'latest-credentials-returned-services-stopped',
            written: 1,
          })
          expect(await readFile(f.input.poolFile, 'utf8')).toBe(poolBefore)
          expect(JSON.parse(await readFile(f.input.nativeAuthFile, 'utf8')).anthropic.refresh).toBe('rotated-refresh')
          expect(await resumeClaudeRollback(f.input)).toEqual({
            phase: 'latest-credentials-returned-services-stopped',
            written: 0,
          })
        } else {
          const before = await readFile(f.input.nativeAuthFile, 'utf8')
          await expect(resumeClaudeRollback(f.input)).rejects.toMatchObject({
            code: 'SOURCE_CHANGED',
          })
          expect(await readFile(f.input.nativeAuthFile, 'utf8')).toBe(before)
        }
      } finally {
        await rm(f.root, { recursive: true })
      }
    },
  )
  it('returns current proxy tokens to both original stores and preserves other providers', async () => {
    const f = await fixture()
    try {
      expect(await rollbackClaudeTransfer(f.input)).toEqual({
        phase: 'latest-credentials-returned-services-stopped',
      })
      const pool = JSON.parse(await readFile(f.input.poolFile, 'utf8'))
      const auth = JSON.parse(await readFile(f.input.nativeAuthFile, 'utf8'))
      expect(pool.accounts[0].credentials).toMatchObject({
        access: 'new-access',
        refresh: 'rotated-refresh',
      })
      expect(auth.anthropic).toMatchObject({
        access: 'new-access',
        refresh: 'rotated-refresh',
      })
      expect(auth.openai).toEqual(f.auth.openai)
      await expect(rollbackClaudeTransfer(f.input)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
      })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('does not bypass an existing provider access-denial marker', async () => {
    const f = await fixture()
    try {
      await new ClaudeProxyGate(f.input.gateDirectory).deny()
      await expect(rollbackClaudeTransfer(f.input)).rejects.toMatchObject({
        code: 'SOURCE_BLOCKED',
      })
      expect(await readdir(f.input.stagingDirectory)).not.toContain('rollback-intent.json')
      expect(JSON.parse(await readFile(f.input.nativeAuthFile, 'utf8'))).toEqual(f.auth)
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
  it('leaves explicit incomplete state when stopped status is lost after the first replacement', async () => {
    const f = await fixture()
    try {
      let calls = 0
      await expect(
        rollbackClaudeTransfer({
          ...f.input,
          assertQuiescent: async () => {
            if (++calls === 3) throw new Error('busy')
          },
        }),
      ).rejects.toThrow()
      const entries = await readdir(f.input.stagingDirectory)
      expect(entries).toContain('rollback-pool-written.json')
      expect(entries).not.toContain('rollback-complete.json')
      expect(JSON.parse(await readFile(f.input.poolFile, 'utf8')).accounts[0].credentials.refresh).toBe(
        'rotated-refresh',
      )
      expect(JSON.parse(await readFile(f.input.nativeAuthFile, 'utf8'))).toEqual(f.auth)
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
})
