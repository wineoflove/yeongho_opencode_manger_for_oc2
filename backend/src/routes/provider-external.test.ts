import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { IntegrationInfo, OpenCodeApi } from '@opencode-manager/shared/opencode'
import { createStubOpenCodeClient } from '../../test/helpers/stub-opencode-client'
import { createProvidersRoutes } from './providers'

const endpoint = '/providers/claude-agent/external-login'
const externalMethod = {
  type: 'external',
  id: 'claude-login',
  label: 'private-label',
} as const
const connection = {
  type: 'credential',
  method: 'external',
  id: 'private-id',
  label: 'private-label',
} as const

function fixture() {
  const client = createStubOpenCodeClient()
  client.api.provider = {
    ...client.api.provider,
    list: vi.fn(async () => ({
      location: { directory: '/tmp/test' },
      data: [],
    })),
  }
  let integration: IntegrationInfo = {
    id: 'claude-agent',
    name: 'Claude',
    methods: [externalMethod],
    connections: [],
  }
  vi.mocked(client.api.integration.get).mockImplementation(async () => ({
    location: { directory: '/tmp/test' },
    data: integration,
  }))
  const external = vi.fn<OpenCodeApi['integration']['connect']['external']>(async () => {
    integration = { ...integration, connections: [connection] }
  })
  client.api.integration.connect.external = external
  const app = new Hono().route('/providers', createProvidersRoutes(client))
  return {
    app,
    client,
    external,
    setIntegration: (value: IntegrationInfo) => {
      integration = value
    },
  }
}

describe('Claude Code external login', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    { connections: [], status: 'unconnected' },
    { connections: [connection], status: 'connected' },
    {
      connections: [
        {
          ...connection,
          status: {
            status: 'needs_auth' as const,
            message: 'secret',
            url: 'secret',
          },
        },
      ],
      status: 'needs_auth',
    },
  ])('reports native $status without private connection data or catalog access', async ({ connections, status }) => {
    const { app, client, setIntegration } = fixture()
    setIntegration({
      id: 'claude-agent',
      name: 'secret',
      methods: [externalMethod],
      connections,
    })
    const response = await app.request(endpoint)
    const body = await response.json()
    expect(body).toMatchObject({
      available: true,
      status,
      connectionScope: 'current_host_login',
      supportsMultipleAccounts: false,
    })
    expect(JSON.stringify(body)).not.toMatch(/secret|private-/)
    expect(client.api.provider.list).not.toHaveBeenCalled()
    expect(client.api.credential.list).not.toHaveBeenCalled()
  })

  it('records one marker for concurrent and repeated requests', async () => {
    const { app, external } = fixture()
    const responses = await Promise.all([
      app.request(endpoint, { method: 'POST' }),
      app.request(endpoint, { method: 'POST' }),
    ])
    responses.push(await app.request(endpoint, { method: 'POST' }))
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(external).toHaveBeenCalledExactlyOnceWith({
      integrationID: 'claude-agent',
      methodID: 'claude-login',
    })
  })

  it.each(['needs_auth', 'unconnected'] as const)(
    'does not infer connected from marker insertion: %s',
    async (status) => {
      const { app, external, setIntegration } = fixture()
      external.mockImplementation(async () => {
        setIntegration({
          id: 'claude-agent',
          name: 'Claude',
          methods: [externalMethod],
          connections:
            status === 'needs_auth'
              ? [
                  {
                    ...connection,
                    status: { status: 'needs_auth', message: 'private' },
                  },
                ]
              : [],
        })
      })
      const response = await app.request(endpoint, { method: 'POST' })
      expect(await response.json()).toMatchObject({ status })
    },
  )

  it('keeps an existing needs_auth marker instead of creating another account', async () => {
    const { app, external, setIntegration } = fixture()
    setIntegration({
      id: 'claude-agent',
      name: 'Claude',
      methods: [externalMethod],
      connections: [{ ...connection, status: { status: 'needs_auth', message: 'private' } }],
    })
    const response = await app.request(endpoint, { method: 'POST' })
    expect(await response.json()).toMatchObject({ status: 'needs_auth' })
    expect(external).not.toHaveBeenCalled()
  })

  it.each([[], [{ ...externalMethod, id: 'other' }], [{ type: 'oauth' as const, id: 'claude-login', label: 'Other' }]])(
    'rejects unavailable external methods',
    async (...methods) => {
      const { app, external, setIntegration } = fixture()
      setIntegration({
        id: 'claude-agent',
        name: 'Claude',
        methods: methods.flat(),
        connections: [],
      })
      const response = await app.request(endpoint, { method: 'POST' })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        available: false,
        status: 'unavailable',
      })
      expect(external).not.toHaveBeenCalled()
    },
  )

  it.each(['{"methodID":"other"}', '{"answer":{"command":"bad"}}', '{"token":"secret"}', '{', 'null'])(
    'rejects client-controlled connection input: %s',
    async (body) => {
      const { app, external } = fixture()
      const response = await app.request(endpoint, { method: 'POST', body })
      expect(response.status).toBe(400)
      expect(external).not.toHaveBeenCalled()
    },
  )

  it('does not offer the endpoint for other integrations', async () => {
    const { app, external } = fixture()
    expect(
      (
        await app.request('/providers/anthropic/external-login', {
          method: 'POST',
        })
      ).status,
    ).toBe(404)
    expect(external).not.toHaveBeenCalled()
  })

  it('waits for native integration discovery', async () => {
    vi.useFakeTimers()
    const { app, client } = fixture()
    vi.mocked(client.api.integration.get).mockRejectedValueOnce({
      _tag: 'IntegrationNotFoundError',
    })
    const request = app.request(endpoint)
    await vi.runAllTimersAsync()
    expect(await (await request).json()).toMatchObject({
      status: 'unconnected',
      available: true,
    })
  })

  it('reports unavailable when native integration discovery expires', async () => {
    vi.useFakeTimers()
    const { app, client } = fixture()
    vi.mocked(client.api.integration.get).mockRejectedValue({
      _tag: 'IntegrationNotFoundError',
    })
    const request = app.request(endpoint)
    await vi.runAllTimersAsync()
    expect(await (await request).json()).toMatchObject({
      status: 'unavailable',
      available: false,
    })
  })

  it.each(['GET', 'POST'])('sanitizes native read errors for %s', async (method) => {
    const { app, client } = fixture()
    vi.mocked(client.api.integration.get).mockRejectedValue(new Error('secret-token'))
    const response = await app.request(endpoint, { method })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret-token')
  })

  it('clears a failed in-flight registration so a later request can succeed', async () => {
    const { app, external } = fixture()
    external.mockRejectedValueOnce(new Error('secret-token'))
    const failed = await app.request(endpoint, { method: 'POST' })
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('secret-token')
    expect((await app.request(endpoint, { method: 'POST' })).status).toBe(200)
  })
})
