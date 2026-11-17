import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stageClaimedRefresh, returnClaimedRefresh } from '../../../../bin/claimed-refresh-files.mjs'
import { refreshClaimedClaudeCredential } from '../../../../bin/claimed-claude-refresh.mjs'

const fault = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../src/services/claude-database-files', async (original) => {
  const actual = await original<typeof import('../../src/services/claude-database-files')>()
  return {
    ...actual,
    syncDatabasePath: async (path: string, directory?: boolean) => {
      if (path === fault.directory && directory) throw new Error('fixture-parent-sync-failure')
      return actual.syncDatabasePath(path, directory)
    },
  }
})

it('does not complete a reused credential return until source file and directory durability succeed', async () => {
  const root = await mkdtemp('/Users/yeonghokim/apps/ocm-v2-staging/run/claude-refresh-')
  const sourceRoot = await mkdtemp('/Users/yeonghokim/apps/ocm-v2-staging/run/claude-source-fixture-')
  const source = join(sourceRoot, 'accounts.json')
  const server = createServer(async (_request, response) => {
    try {
      await writeFile(
        join(root, 'auths/legacy-main.json'),
        JSON.stringify({
          type: 'claude',
          disabled: true,
          access_token: 'latest-fixture-access',
          refresh_token: 'latest-fixture-refresh',
          expired: '2030-01-01T00:00:00.000Z',
        }),
        { mode: 0o600 },
      )
      response.writeHead(200)
      response.end('{}')
    } catch {
      response.writeHead(500)
      response.end()
    }
  })
  try {
    server.listen(0, '0.0.0.0')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture-listener-unavailable')
    const endpoint = `http://127.0.0.1:${address.port}`
    const original = JSON.stringify({
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
          credentials: {
            type: 'oauth',
            access: 'old',
            refresh: 'old-refresh',
            expires: 1,
          },
        },
      ],
    })
    await writeFile(source, original, { mode: 0o600 })
    const staged = await stageClaimedRefresh({
      root,
      source,
      sourceSha256: createHash('sha256').update(original).digest('hex'),
      assertLegacyStopped: async () => {},
    })
    const first = staged.files[0]
    if (!first) throw new Error('fixture-stage-empty')
    await refreshClaimedClaudeCredential({
      root,
      fileName: first.fileName,
      originalSha256: first.sha256,
      endpoint,
      managementKey: 'fixture',
      assertExclusive: async () => {},
      minimumLifetimeMs: 60000,
    })
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const input = {
      root,
      source,
      endpoint,
      minimumLifetimeMs: 60000,
      assertOwnersStopped: async () => {},
    }
    fault.directory = sourceRoot
    await expect(returnClaimedRefresh(input)).rejects.toMatchObject({
      legacyRestartAllowed: false,
    })
    expect(JSON.parse(await readFile(source, 'utf8')).accounts[0].credentials.access).toBe('latest-fixture-access')
    await expect(returnClaimedRefresh(input)).rejects.toMatchObject({
      legacyRestartAllowed: false,
    })
    await expect(readFile(join(root, 'returned.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    fault.directory = ''
    await expect(returnClaimedRefresh(input)).resolves.toMatchObject({
      state: 'latest-credentials-returned',
      legacyRestartAllowed: false,
    })
  } finally {
    fault.directory = ''
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true })
    await rm(sourceRoot, { recursive: true })
  }
})
