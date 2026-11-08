import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL } from '@/config'
import { providerAccountsApi } from './provider-accounts'
import { fetchWrapper } from './fetchWrapper'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))

describe('provider account API contract', () => {
  beforeEach(() => vi.resetAllMocks())

  it('keeps only public account fields and encodes the integration path', async () => {
    const account = {
      id: 'credential',
      integrationID: 'provider/name',
      label: 'Primary',
      active: true,
      type: 'key',
      methodID: null,
    }
    vi.mocked(fetchWrapper).mockResolvedValue({
      accounts: [{ ...account, value: { key: 'private' } }],
    })
    expect(await providerAccountsApi.list('provider/name')).toEqual({
      accounts: [account],
    })
    expect(fetchWrapper).toHaveBeenCalledExactlyOnceWith(`${API_BASE_URL}/api/providers/provider%2Fname/accounts`)
  })

  it('sends only the normalized label for a rename without activating the account', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      success: true,
      accountId: 'id/?',
      label: 'New',
    })
    await providerAccountsApi.rename('provider', 'id/?', ' New ')
    expect(fetchWrapper).toHaveBeenCalledExactlyOnceWith(`${API_BASE_URL}/api/providers/provider/accounts/id%2F%3F`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New' }),
    })
  })

  it('rejects an empty name before any request', async () => {
    await expect(providerAccountsApi.rename('provider', 'id', ' ')).rejects.toThrow()
    expect(fetchWrapper).not.toHaveBeenCalled()
  })

  it('uses individual activation and deletion endpoints', async () => {
    vi.mocked(fetchWrapper)
      .mockResolvedValueOnce({ success: true, activeAccountId: 'id' })
      .mockResolvedValueOnce({ success: true, deletedAccountId: 'id' })
    await providerAccountsApi.activate('provider', 'id')
    await providerAccountsApi.remove('provider', 'id')
    expect(fetchWrapper).toHaveBeenNthCalledWith(1, `${API_BASE_URL}/api/providers/provider/accounts/id/activate`, {
      method: 'POST',
    })
    expect(fetchWrapper).toHaveBeenNthCalledWith(2, `${API_BASE_URL}/api/providers/provider/accounts/id`, {
      method: 'DELETE',
    })
  })

  it('does not interpret a malformed success response as confirmed activation', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({
      success: false,
      activeAccountId: 'id',
    })
    await expect(providerAccountsApi.activate('provider', 'id')).rejects.toThrow()
  })
})
