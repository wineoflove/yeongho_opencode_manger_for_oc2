import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../helpers/assistant-workspace'
import { createStubOpenCodeClient } from '../helpers/stub-opencode-client'
import { SettingsService } from '../../src/services/settings'
import { readOpenCodeConfigFile } from '../../src/services/opencode-config-file'
import { createProviderPoolRoutes } from '../../src/routes/provider-pool'

const paths = vi.hoisted(() => ({ root: '' }))
const pending = vi.hoisted(() => vi.fn())
vi.mock('@opencode-manager/shared/config/env', async (original) => ({
  ...(await original<typeof import('@opencode-manager/shared/config/env')>()),
  getConfigPath: () => paths.root,
  getOpenCodeConfigFilePath: () => join(paths.root, 'opencode.json'),
  getOpenCodeConfigHome: () => join(paths.root, 'home'),
  getOpenCodeHealthWatchPath: () => join(paths.root, 'health-watch'),
  OPENCODE_CONFIG_SOURCE_NAMES: ['opencode.json', 'opencode.jsonc'],
}))
vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: {
    markRestartPending: pending,
    clearStartupError: vi.fn(),
  },
  ConfigReloadError: class ConfigReloadError extends Error {},
}))

const original = {
  model: 'openai/fixture-model',
  providers: {
    openai: {
      settings: {
        baseURL: 'https://example.invalid/v1',
        apiKey: 'fixture-secret-kept',
      },
    },
    anthropic: { settings: { temperature: 0.4 } },
  },
  mcp: {
    servers: {
      fixture: {
        type: 'remote',
        url: 'https://example.invalid/mcp',
        disabled: true,
      },
    },
  },
}
const accounts = [
  { credentialID: 'cred_A', enabled: true },
  { credentialID: 'cred_B', enabled: false },
]
let db: ReturnType<typeof createTestDb>

async function fixture() {
  const client = createStubOpenCodeClient({
    forwardRaw: vi.fn(async () =>
      Response.json({
        data: {
          integrationID: 'openai',
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
      id: 'openai',
      name: 'OpenAI',
      methods: [{ type: 'key' }],
      connections: accounts.map((entry) => ({
        type: 'credential',
        method: 'key',
        id: entry.credentialID,
        label: entry.credentialID,
      })),
    },
  })
  vi.mocked(client.api.credential.list).mockResolvedValue(
    accounts.map((entry) => ({
      id: entry.credentialID,
      integrationID: 'openai',
      label: entry.credentialID,
      active: entry.enabled,
      value: { type: 'key', key: 'fixture-only-key' },
    })),
  )
  vi.mocked(client.api.location.reload).mockResolvedValue(undefined)
  const settings = new SettingsService(db)
  const app = createProviderPoolRoutes(client, settings)
  const current = await readOpenCodeConfigFile()
  if (!current) throw new Error('Expected fixture config')
  const put = () =>
    app.request('/openai/pool', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision, accounts }),
    })
  return { client, settings, put }
}

describe('pool configuration file integration', () => {
  it('does not write stale membership when a credential disappears before the locked write', async () => {
    const { put, client } = await fixture()
    const initial = await client.api.credential.list()
    vi.mocked(client.api.credential.list).mockResolvedValueOnce(initial).mockResolvedValueOnce([])
    const before = await readFile(join(paths.root, 'opencode.json'), 'utf8')
    const response = await put()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'POOL_CONFIG_CONFLICT',
    })
    expect(await readFile(join(paths.root, 'opencode.json'), 'utf8')).toBe(before)
    expect(client.api.location.reload).not.toHaveBeenCalled()
  })
  beforeEach(async () => {
    vi.clearAllMocks()
    paths.root = await mkdtemp(join(tmpdir(), 'pool-config-file-'))
    db = createTestDb()
    await writeFile(join(paths.root, 'opencode.json'), JSON.stringify(original))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    db.close()
    await rm(paths.root, { recursive: true, force: true })
  })

  it('preserves other settings and stores pool membership without returning secrets', async () => {
    const { put, client, settings } = await fixture()
    const response = await put()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      saved: true,
      applyStatus: 'reloaded',
    })
    const config = await readOpenCodeConfigFile()
    expect(config?.content).toEqual({
      ...original,
      providers: {
        ...original.providers,
        openai: {
          settings: {
            ...original.providers.openai.settings,
            accountPool: { strategy: 'round-robin', accounts },
          },
        },
      },
    })
    expect(settings.getLastKnownGoodConfig()).toContain('fixture-secret-kept')
    expect(client.api.credential.activate).not.toHaveBeenCalled()
    expect(client.api.credential.remove).not.toHaveBeenCalled()
    expect(client.forwardRaw).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale revision and preserves the concurrent configuration change', async () => {
    const { put, client } = await fixture()
    const concurrent = JSON.stringify({
      ...original,
      model: 'openai/concurrent-model',
    })
    await writeFile(join(paths.root, 'opencode.json'), concurrent)
    const response = await put()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'POOL_CONFIG_CONFLICT',
    })
    expect(await readFile(join(paths.root, 'opencode.json'), 'utf8')).toBe(concurrent)
    expect(client.api.location.reload).not.toHaveBeenCalled()
  })

  it('reports restart pending separately when the saved configuration cannot reload', async () => {
    const { put, client } = await fixture()
    vi.mocked(client.api.location.reload).mockRejectedValue(new Error('fixture reload failure'))
    expect(await (await put()).json()).toEqual({
      saved: true,
      applyStatus: 'restart_pending',
    })
    expect((await readOpenCodeConfigFile())?.content).toMatchObject({
      providers: { openai: { settings: { accountPool: { accounts } } } },
    })
    expect(pending).toHaveBeenCalledOnce()
  })

  it('restores the old file if preserving the last-known-good configuration fails', async () => {
    const { put, settings, client } = await fixture()
    vi.spyOn(settings, 'saveLastKnownGoodConfig').mockImplementation(() => {
      throw new Error('private archive failure')
    })
    const before = await readFile(join(paths.root, 'opencode.json'), 'utf8')
    const response = await put()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private archive failure')
    expect(await readFile(join(paths.root, 'opencode.json'), 'utf8')).toBe(before)
    expect(client.api.location.reload).not.toHaveBeenCalled()
  })
})
