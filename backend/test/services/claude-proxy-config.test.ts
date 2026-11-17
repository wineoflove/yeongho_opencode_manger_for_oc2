import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { loadClaudeProxyClient } from '../../src/services/claude-proxy-config'

describe('Claude proxy opt-in configuration', () => {
  it('leaves native mode unchanged when configuration is absent', async () => {
    expect(await loadClaudeProxyClient({})).toBeUndefined()
  })

  it.each([
    { OCM_CLAUDE_PROXY_URL: 'http://127.0.0.1:5117' },
    { OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: '/unused/private-key' },
    {
      OCM_CLAUDE_PROXY_URL: 'http://127.0.0.1:5117',
      OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: 'relative-key',
    },
  ])('rejects partial configuration rather than silently falling back', async (environment) => {
    await expect(loadClaudeProxyClient(environment)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
  })

  it('authenticates from a private file without refreshing any credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxy-config-'))
    const key = join(root, 'key')
    await writeFile(key, 'test-file-management-secret\n', { mode: 0o600 })
    const server = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer test-file-management-secret' || request.method !== 'GET') {
        response.writeHead(403).end()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ observed_at: '2026-11-12T06:00:00Z', files: [] }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test_listener_missing')
      const client = await loadClaudeProxyClient({
        OCM_CLAUDE_PROXY_URL: `http://127.0.0.1:${address.port}`,
        OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: key,
      })
      expect(await client?.listAccounts()).toEqual({
        observedAt: '2026-11-12T06:00:00Z',
        accounts: [],
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await rm(root, { recursive: true })
    }
  })

  it.each(['readable-by-group', 'symlink', 'hardlink', 'directory', 'empty', 'oversized', 'missing'])(
    'rejects unsafe secret input: %s',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'proxy-config-'))
      const key = join(root, 'key')
      try {
        await writeFile(key, 'test-file-management-secret', { mode: 0o600 })
        let selected = key
        switch (kind) {
          case 'readable-by-group':
            await chmod(key, 0o640)
            break
          case 'symlink':
            selected = join(root, 'alias')
            await symlink(key, selected)
            break
          case 'hardlink':
            await link(key, join(root, 'alias'))
            break
          case 'directory':
            selected = join(root, 'directory')
            await mkdir(selected)
            break
          case 'empty':
            await writeFile(key, '')
            break
          case 'oversized':
            await writeFile(key, 'x'.repeat(4097))
            break
          case 'missing':
            selected = join(root, 'missing')
            break
          default:
            throw new Error('unexpected_test_case')
        }
        await expect(
          loadClaudeProxyClient({
            OCM_CLAUDE_PROXY_URL: 'http://127.0.0.1:5117',
            OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: selected,
          }),
        ).rejects.toMatchObject({
          code: 'KEY_FILE_REJECTED',
          message: 'KEY_FILE_REJECTED',
        })
      } finally {
        await rm(root, { recursive: true })
      }
    },
  )
})
