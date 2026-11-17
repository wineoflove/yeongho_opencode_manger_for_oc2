import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { protectRawClaudeMutations } from '../../src/routes/claude-raw-ownership'

function app(ownsInference = true) {
  const router = new Hono()
  router.use(
    '*',
    protectRawClaudeMutations({
      ownsInference,
      async credentialIntegration(id) {
        return { claude: 'anthropic', openai: 'openai' }[id]
      },
    }),
  )
  router.all('*', async (c) => c.json({ forwarded: true, body: await c.req.text() }))
  return router
}

describe('raw credential proxy ownership', () => {
  it.each([
    ['{', 400],
    ['{}', 400],
    ['x'.repeat(65537), 413],
  ])('rejects invalid or oversized credential bodies', async (body, status) => {
    const response = await app().request('/api/opencode-proxy/api/credential', {
      method: 'POST',
      body,
    })
    expect(response.status).toBe(status)
  })

  it('does not expose lookup errors', async () => {
    const router = new Hono()
    router.use(
      '*',
      protectRawClaudeMutations({
        ownsInference: true,
        async credentialIntegration() {
          throw new Error('sensitive-upstream-detail')
        },
      }),
    )
    router.all('*', (c) => c.text('unexpected'))
    const response = await router.request('/api/opencode-proxy/api/credential/id/activate', { method: 'POST' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'CREDENTIAL_OWNERSHIP_UNVERIFIED',
    })
  })
  it.each([
    ['POST', '/api/credential/claude/activate'],
    ['DELETE', '/api/credential/claude'],
    ['PATCH', '/api/credential/claude'],
    ['POST', '/api/integration/anthropic/connect/key'],
    ['POST', '/api/integration/%61nthropic/oauth/connect'],
  ])('blocks Claude mutation %s %s', async (method, path) => {
    const response = await app().request('/api/opencode-proxy/repos/7' + path, {
      method,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'CLAUDE_PROXY_MANAGED',
      error: 'Claude accounts are managed by CLIProxyAPI.',
    })
  })
  it('blocks creation while preserving other provider request bodies', async () => {
    const router = app()
    for (const integrationID of ['anthropic', 'openai']) {
      const body = JSON.stringify({
        integrationID,
        value: { type: 'key', key: 'synthetic' },
      })
      const response = await router.request('/api/opencode-proxy/api/credential', { method: 'POST', body })
      expect(response.status).toBe(integrationID === 'anthropic' ? 409 : 200)
      if (integrationID === 'openai') expect(await response.json()).toEqual({ forwarded: true, body })
    }
  })
  it.each([
    [true, 'GET', 'claude', 200],
    [true, 'POST', 'openai', 200],
    [true, 'POST', 'missing', 503],
    [false, 'POST', 'claude', 200],
  ])('preserves allowed calls and fails closed for unknown ownership', async (enabled, method, id, expected) => {
    expect((await app(enabled).request(`/api/opencode-proxy/api/credential/${id}/activate`, { method })).status).toBe(
      expected,
    )
  })
})
