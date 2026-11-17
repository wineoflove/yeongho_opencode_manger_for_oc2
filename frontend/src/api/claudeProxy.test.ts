import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyApi } from './claudeProxy'
import { fetchWrapper } from './fetchWrapper'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const account = {
  id: 'aa47ac1b75dc0765',
  provider: 'claude',
  label: 'work@example.com',
  enabled: true,
  available: true,
  successCount: 12,
  failureCount: 1,
  lastRefreshedAt: null,
  nextRetryAt: null,
}

describe('Claude proxy response boundary', () => {
  it('strips credential fields from an account response', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      configured: true,
      observedAt: '2026-11-12T08:00:00Z',
      access_token: 'private',
      accounts: [{ ...account, source: 'private-api-key' }],
    })
    expect(await claudeProxyApi.accounts()).toEqual({
      configured: true,
      observedAt: '2026-11-12T08:00:00Z',
      accounts: [account],
    })
  })
  it('rejects incomplete ownership rather than defaulting to native', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({ configured: true })
    await expect(claudeProxyApi.status()).rejects.toThrow()
  })
  it('rejects a sign-in link that would not open an https page', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      provider: 'openai',
      state: 'state-1',
      url: 'javascript:alert(1)',
      expiresAt: '2026-11-12T08:10:00Z',
    })
    await expect(claudeProxyApi.startLogin('openai')).rejects.toThrow()
  })
  it('sends the redirect completion as JSON and waits longer than the Manager does upstream', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({ status: 'ok' })
    await claudeProxyApi.completeLogin({
      provider: 'claude',
      state: 'state-1',
      redirectUrl: 'http://localhost:54545/callback?code=one-time',
    })
    const [url, options] = vi.mocked(fetchWrapper).mock.calls[0] ?? []
    expect(url).toMatch(/\/api\/providers\/claude-proxy\/logins\/complete$/)
    expect(options).toMatchObject({ method: 'POST', timeout: 60_000 })
    expect(JSON.parse(String(options?.body))).toEqual({
      provider: 'claude',
      state: 'state-1',
      redirectUrl: 'http://localhost:54545/callback?code=one-time',
    })
  })
  it.each([
    ['PATCH', () => claudeProxyApi.setAccountEnabled('aa47ac1b75dc0765', false), { enabled: false }],
    ['DELETE', () => claudeProxyApi.deleteAccount('aa47ac1b75dc0765'), undefined],
  ])('addresses %s to the account and requires a confirmation', async (method, call, body) => {
    vi.mocked(fetchWrapper).mockResolvedValue({ status: 'ok' })
    await call()
    const [url, options] = vi.mocked(fetchWrapper).mock.calls[0] ?? []
    expect(url).toMatch(/\/api\/providers\/claude-proxy\/accounts\/aa47ac1b75dc0765$/)
    expect(options?.method).toBe(method)
    expect(options?.body === undefined ? undefined : JSON.parse(String(options.body))).toEqual(body)
    vi.mocked(fetchWrapper).mockResolvedValue({})
    await expect(call()).rejects.toThrow()
  })
})
