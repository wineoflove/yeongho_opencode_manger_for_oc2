import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createStubOpenCodeClient } from '../../test/helpers/stub-opencode-client'
import { createProvidersRoutes } from './providers'

const status = {
  integrationID: 'openai',
  enabled: true,
  strategy: 'round-robin',
  paused: false,
  lastSelectedCredentialID: 'cred_a',
  accounts: [
    {
      credentialID: 'cred_a',
      enabled: true,
      failure: 'rate-limited',
      authInvalid: false,
      cooldownUntil: 300000,
      observedAt: 1,
    },
  ],
}

function fixture(response: Response) {
  const client = createStubOpenCodeClient({
    forwardRaw: vi.fn(async () => response),
  })
  return {
    client,
    app: new Hono().route('/providers', createProvidersRoutes(client)),
  }
}

describe('provider pool status', () => {
  it('returns only typed pool state and removes unknown secrets from the upstream response', async () => {
    const data = {
      ...status,
      token: 'private-token',
      accounts: status.accounts.map((account) => ({
        ...account,
        refresh: 'private-refresh',
      })),
    }
    const { app, client } = fixture(Response.json({ data }))
    const response = await app.request('/providers/openai/pool')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ supported: true, status })
    expect(client.api.credential.list).not.toHaveBeenCalled()
  })

  it('reports unsupported rather than an empty healthy pool on an older native server', async () => {
    const { app } = fixture(new Response('unknown route', { status: 404 }))
    expect(await (await app.request('/providers/openai/pool')).json()).toEqual({
      supported: false,
    })
  })

  it.each([401, 403, 500, 503])('does not expose the upstream failure body for HTTP %s', async (code) => {
    const { app } = fixture(new Response('private-token', { status: code }))
    const response = await app.request('/providers/openai/pool')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private-token')
  })

  it('rejects malformed successful responses instead of reporting a working pool', async () => {
    const { app } = fixture(Response.json({ data: { ...status, paused: 'false' } }))
    expect((await app.request('/providers/openai/pool')).status).toBe(502)
  })
})
