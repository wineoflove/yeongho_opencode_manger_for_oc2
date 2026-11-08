import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL } from '@/config'
import { providerExternalApi } from './providerExternal'
import { fetchWrapper } from './fetchWrapper'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))

const state = {
  integrationID: 'claude-agent',
  methodID: 'claude-login',
  available: true,
  status: 'needs_auth',
  connectionScope: 'current_host_login',
  supportsMultipleAccounts: false,
  instructions: {
    command: 'claude auth login',
    location: 'opencode_host',
    message: 'Use the host login',
  },
}

describe('external login API boundary', () => {
  beforeEach(() => vi.resetAllMocks())

  it.each(['getStatus', 'connect'] as const)('parses %s and excludes unexpected private data', async (operation) => {
    vi.mocked(fetchWrapper).mockResolvedValue({ ...state, token: 'private' })
    expect(await providerExternalApi[operation]()).toEqual(state)
    const endpoint = `${API_BASE_URL}/api/providers/claude-agent/external-login`
    if (operation === 'connect')
      expect(fetchWrapper).toHaveBeenCalledExactlyOnceWith(endpoint, {
        method: 'POST',
      })
    else expect(fetchWrapper).toHaveBeenCalledExactlyOnceWith(endpoint)
  })

  it.each([{ status: 'success' }, { integrationID: 'anthropic' }, { supportsMultipleAccounts: true }])(
    'rejects invalid native response contracts: %j',
    async (change) => {
      vi.mocked(fetchWrapper).mockResolvedValue({ ...state, ...change })
      await expect(providerExternalApi.getStatus()).rejects.toThrow()
    },
  )

  it('propagates registration failures rather than returning a connected state', async () => {
    vi.mocked(fetchWrapper).mockRejectedValue(new Error('Unavailable'))
    await expect(providerExternalApi.connect()).rejects.toThrow('Unavailable')
  })
})
