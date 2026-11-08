import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { ProviderExternalLoginResponseSchema } from '@opencode-manager/shared/schemas'
import { createProvidersRoutes } from '../../src/routes/providers'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { createOpenCodeServeDirectories, resolveOpenCode2Binary, startOpenCodeServe } from '../helpers/opencode-binary'
import type { OpenCodeServe } from '../helpers/opencode-binary'

const binary = resolveOpenCode2Binary()
if (process.env.OPENCODE_BIN && binary !== process.env.OPENCODE_BIN) {
  throw new Error('OPENCODE_BIN must resolve to a supported executable for this integration test')
}

const endpoint = '/providers/claude-agent/external-login'
const target = { integrationID: 'claude-agent' } as const

describe.skipIf(binary === null)('Claude external login against real OpenCode 2', () => {
  it('keeps one marker and reports needs_auth for repeated connects when the Claude executable is missing', async () => {
    const directories = await createOpenCodeServeDirectories()
    let serve: OpenCodeServe | undefined
    try {
      const configDirectory = join(directories.configHome, 'opencode')
      const claudeDirectory = join(directories.root, 'claude')
      await mkdir(configDirectory, { recursive: true })
      await mkdir(claudeDirectory)
      await writeFile(
        join(configDirectory, 'opencode.json'),
        JSON.stringify({
          autoupdate: false,
          providers: {
            'claude-agent': { package: '@opencode/claude-agent' },
          },
          permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        }),
      )
      serve = await startOpenCodeServe({
        directories,
        env: {
          CLAUDE_CONFIG_DIR: claudeDirectory,
          OPENCODE_CLAUDE_PATH: join(directories.root, 'missing-claude'),
          OPENCODE_CONFIG_PROJECT_DISABLE: '1',
        },
      })
      const client = new FetchOpenCodeClient({
        baseUrl: serve.baseUrl,
        basicAuth: buildOpenCodeBasicAuth(serve.password),
        defaultDirectory: false,
      })
      const app = new Hono().route('/providers', createProvidersRoutes(client))
      const initial = await app.request(endpoint)
      expect(initial.status).toBe(200)
      expect(ProviderExternalLoginResponseSchema.parse(await initial.json())).toMatchObject({
        available: true,
        status: 'unconnected',
      })
      expect(await client.api.credential.list()).toEqual([])

      const concurrent = await Promise.all([
        app.request(endpoint, { method: 'POST' }),
        app.request(endpoint, { method: 'POST' }),
      ])
      const repeated = await app.request(endpoint, { method: 'POST' })
      for (const response of [...concurrent, repeated, await app.request(endpoint)]) {
        expect(response.status).toBe(200)
        expect(ProviderExternalLoginResponseSchema.parse(await response.json())).toMatchObject({
          integrationID: 'claude-agent',
          methodID: 'claude-login',
          available: true,
          status: 'needs_auth',
          connectionScope: 'current_host_login',
          supportsMultipleAccounts: false,
        })
      }
      const native = (await client.api.integration.get(target)).data
      expect(native.connections).toEqual([
        expect.objectContaining({
          type: 'credential',
          method: 'external',
          status: expect.objectContaining({ status: 'needs_auth' }),
        }),
      ])
      expect(await client.api.credential.list()).toEqual([
        expect.objectContaining({
          integrationID: 'claude-agent',
          value: expect.objectContaining({
            type: 'external',
            methodID: 'claude-login',
          }),
        }),
      ])
    } finally {
      try {
        await serve?.stop()
      } finally {
        await rm(directories.root, { recursive: true, force: true })
      }
    }
  }, 120000)
})
