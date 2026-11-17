import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProvidersRoutes } from './providers'
import { withOpenCodeConfigLock } from '../services/opencode-config-file'
import { createStubOpenCodeClient } from '../../test/helpers/stub-opencode-client'

const config = vi.hoisted(() => vi.fn())
vi.mock('../services/opencode-config-file', async (original) => ({
  ...(await original<typeof import('../services/opencode-config-file')>()),
  readOpenCodeConfigFile: config,
}))

const account = {
  id: 'cred_A',
  integrationID: 'openai',
  label: 'A',
  active: true,
  value: { type: 'key' as const, key: 'fixture' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pool member deletion guard', () => {
  it('holds the configuration lock until native deletion finishes', async () => {
    config.mockResolvedValue({ isValid: true, content: {} })
    const client = createStubOpenCodeClient()
    vi.mocked(client.api.credential.list).mockResolvedValueOnce([account]).mockResolvedValueOnce([])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    vi.mocked(client.api.credential.remove).mockImplementation(async () => {
      order.push('remove:start')
      entered.resolve()
      await release.promise
      order.push('remove:end')
    })
    const deleting = createProvidersRoutes(client).request('/openai/accounts/cred_A', { method: 'DELETE' })
    await entered.promise
    const writing = withOpenCodeConfigLock(async () => {
      order.push('config:write')
    })
    await Promise.resolve()
    release.resolve()
    expect((await deleting).status).toBe(200)
    await writing
    expect(order).toEqual(['remove:start', 'remove:end', 'config:write'])
  })
  it('blocks deletion when the saved config is empty but the runtime still references the account', async () => {
    config.mockResolvedValue({ isValid: true, content: {} })
    const client = createStubOpenCodeClient()
    vi.mocked(client.api.credential.list).mockResolvedValue([account])
    vi.mocked(client.forwardRaw)
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'alias' }] }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            integrationID: 'openai',
            enabled: true,
            strategy: 'round-robin',
            paused: false,
            lastSelectedCredentialID: null,
            accounts: [
              {
                credentialID: 'cred_A',
                enabled: true,
                failure: null,
                authInvalid: false,
                cooldownUntil: null,
                observedAt: null,
              },
            ],
          },
        }),
      )
    const response = await createProvidersRoutes(client).request('/openai/accounts/cred_A', { method: 'DELETE' })
    expect(response.status).toBe(409)
    expect(client.api.credential.remove).not.toHaveBeenCalled()
  })

  it('does not delete when runtime pool state is unavailable', async () => {
    config.mockResolvedValue({ isValid: true, content: {} })
    const client = createStubOpenCodeClient()
    vi.mocked(client.api.credential.list).mockResolvedValue([account])
    vi.mocked(client.forwardRaw).mockResolvedValue(Response.json({ error: 'private' }, { status: 503 }))
    const response = await createProvidersRoutes(client).request('/openai/accounts/cred_A', { method: 'DELETE' })
    expect(response.status).toBe(503)
    expect(client.api.credential.remove).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('private')
  })
  it.each(['/openai/accounts/cred_A', '/openai/credentials'])(
    'blocks %s before removing any credential',
    async (route) => {
      config.mockResolvedValue({
        isValid: true,
        content: {
          providers: {
            alias: {
              settings: {
                accountPool: {
                  strategy: 'round-robin',
                  accounts: [{ credentialID: 'cred_A', enabled: false }],
                },
              },
            },
          },
        },
      })
      const client = createStubOpenCodeClient()
      vi.mocked(client.api.credential.list).mockResolvedValue([account])
      vi.mocked(client.api.integration.get).mockResolvedValue({
        location: { directory: '/fixture' },
        data: {
          id: 'openai',
          name: 'OpenAI',
          methods: [{ type: 'key' }],
          connections: [{ type: 'credential', id: 'cred_A', label: 'A', method: 'key' }],
        },
      })
      const response = await createProvidersRoutes(client).request(route, {
        method: 'DELETE',
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'POOL_ACCOUNT_IN_USE',
      })
      expect(client.api.credential.remove).not.toHaveBeenCalled()
    },
  )

  it('fails closed when the managed configuration is invalid', async () => {
    config.mockResolvedValue({ isValid: false, content: {} })
    const client = createStubOpenCodeClient()
    vi.mocked(client.api.credential.list).mockResolvedValue([account])
    const response = await createProvidersRoutes(client).request('/openai/accounts/cred_A', { method: 'DELETE' })
    expect(response.status).toBe(503)
    expect(client.api.credential.remove).not.toHaveBeenCalled()
  })

  it('preserves deletion of an unreferenced credential', async () => {
    config.mockResolvedValue({ isValid: true, content: {} })
    const client = createStubOpenCodeClient()
    vi.mocked(client.api.credential.list).mockResolvedValueOnce([account]).mockResolvedValueOnce([])
    const response = await createProvidersRoutes(client).request('/openai/accounts/cred_A', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(client.api.credential.remove).toHaveBeenCalledWith({
      credentialID: 'cred_A',
    })
  })
})
