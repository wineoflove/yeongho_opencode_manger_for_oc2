import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createStubOpenCodeClient } from '../../test/helpers/stub-opencode-client'
import { createTestDb } from '../../test/helpers/assistant-workspace'
import { SettingsService } from '../services/settings'
import { applyOpenCodeConfigUpdate } from '../services/opencode-config-apply'
import { createProvidersRoutes } from './providers'

vi.mock('../services/opencode-config-apply', () => ({
  applyOpenCodeConfigUpdate: vi.fn(),
}))

const ids = ['cred_A', 'cred_B']
const request = {
  expectedRevision: 'revision-before',
  accounts: ids.map((credentialID) => ({ credentialID, enabled: true })),
}
let db: ReturnType<typeof createTestDb>

function fixture() {
  const client = createStubOpenCodeClient({
    forwardRaw: vi.fn(async () =>
      Response.json({
        data: {
          integrationID: 'auth-provider',
          enabled: false,
          strategy: null,
          paused: true,
          lastSelectedCredentialID: null,
          accounts: [],
        },
      }),
    ),
  })
  vi.mocked(client.api.integration.get).mockResolvedValue({
    location: { directory: '/fixture' },
    data: {
      id: 'auth-provider',
      name: 'Fixture',
      methods: [{ type: 'key' }],
      connections: ids.map((id) => ({
        id,
        type: 'credential',
        method: 'key',
        label: id,
      })),
    },
  })
  vi.mocked(client.api.credential.list).mockResolvedValue(
    ids.map((id) => ({
      id,
      integrationID: 'auth-provider',
      label: id,
      active: id === 'cred_B',
      value: { type: 'key', key: 'fixture-secret' },
    })),
  )
  const app = new Hono().route('/providers', createProvidersRoutes(client, new SettingsService(db)))
  const put = (body: unknown) =>
    app.request('/providers/model-provider/pool', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { app, put, client }
}

describe('pool configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    db = createTestDb()
    vi.mocked(applyOpenCodeConfigUpdate).mockResolvedValue({
      status: 'restart_pending',
      config: {
        path: '/fixture/opencode.json',
        content: { secret: 'private' },
        rawContent: '{}',
        isValid: true,
        updatedAt: 1,
        sources: [],
        revision: 'after',
      },
    })
  })
  afterEach(() => db.close())

  it('persists an empty pool without deleting credentials or resuming the pool', async () => {
    const { put, client } = fixture()
    const response = await put({ ...request, accounts: [] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      saved: true,
      applyStatus: 'restart_pending',
    })
    expect(applyOpenCodeConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          providers: {
            'model-provider': {
              settings: {
                accountPool: { strategy: 'round-robin', accounts: [] },
              },
            },
          },
        },
      }),
    )
    expect(client.api.credential.remove).not.toHaveBeenCalled()
    expect(client.api.credential.activate).not.toHaveBeenCalled()
  })

  it('merges only the requested pool into the model provider and reports pending runtime application', async () => {
    const { put, client } = fixture()
    const response = await put(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      saved: true,
      applyStatus: 'restart_pending',
    })
    expect(applyOpenCodeConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 'revision-before',
        mode: 'merge',
        content: {
          providers: {
            'model-provider': {
              settings: {
                accountPool: {
                  strategy: 'round-robin',
                  accounts: request.accounts,
                },
              },
            },
          },
        },
      }),
    )
    expect(client.api.credential.activate).not.toHaveBeenCalled()
    expect(client.api.credential.remove).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { ...request, expectedRevision: '' },
    { ...request, accounts: [request.accounts[0], request.accounts[0]] },
    { ...request, resume: true },
  ])('rejects malformed or duplicate membership before writing', async (body) => {
    const { put } = fixture()
    expect((await put(body)).status).toBe(400)
    expect(applyOpenCodeConfigUpdate).not.toHaveBeenCalled()
  })

  it('rejects an account not connected to the requested integration', async () => {
    const { put } = fixture()
    expect(
      (
        await put({
          ...request,
          accounts: [{ credentialID: 'foreign', enabled: true }],
        })
      ).status,
    ).toBe(409)
    expect(applyOpenCodeConfigUpdate).not.toHaveBeenCalled()
  })

  it('rejects mixed OAuth methods before endpoint selection can be confused', async () => {
    const { put, client } = fixture()
    vi.mocked(client.api.credential.list).mockResolvedValue(
      ids.map((id) => ({
        id,
        integrationID: 'auth-provider',
        label: id,
        active: id === 'cred_B',
        value: {
          type: 'oauth',
          methodID: id === 'cred_A' ? 'chatgpt-headless' : 'chatgpt-token-sharing',
          access: 'private-access',
          refresh: 'private-refresh',
          expires: 1,
        },
      })),
    )
    const response = await put(request)
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('private-')
    expect(applyOpenCodeConfigUpdate).not.toHaveBeenCalled()
  })

  it('refuses to configure a runtime without pool support', async () => {
    const { put, client } = fixture()
    vi.mocked(client.forwardRaw).mockResolvedValue(new Response(null, { status: 404 }))
    expect((await put(request)).status).toBe(409)
    expect(applyOpenCodeConfigUpdate).not.toHaveBeenCalled()
  })
})
