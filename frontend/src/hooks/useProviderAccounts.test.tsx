import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { providerAccountsApi } from '@/api/provider-accounts'
import { useProviderAccounts } from './useProviderAccounts'

vi.mock('@/api/provider-accounts', () => ({
  providerAccountsApi: {
    list: vi.fn(),
    activate: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}))

describe('provider account state', () => {
  beforeEach(() => vi.resetAllMocks())

  it.each([true, false])('refreshes account state after a mutation settles, success=%s', async (success) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    client.setQueryData(['provider-credentials'], ['provider'])
    const old = {
      id: 'account',
      integrationID: 'provider',
      label: 'Old',
      active: true,
      type: 'key' as const,
      methodID: null,
    }
    vi.mocked(providerAccountsApi.list)
      .mockResolvedValueOnce({ accounts: [old] })
      .mockResolvedValue({ accounts: [{ ...old, label: 'Current' }] })
    if (success)
      vi.mocked(providerAccountsApi.rename).mockResolvedValue({
        success: true,
        accountId: 'account',
        label: 'New',
      })
    else vi.mocked(providerAccountsApi.rename).mockRejectedValue(new Error('Rename not confirmed'))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(() => useProviderAccounts('provider'), { wrapper })
    try {
      await waitFor(() => expect(result.current.query.data?.accounts[0]?.label).toBe('Old'))
      await act(async () => {
        const request = result.current.mutation.mutateAsync({
          kind: 'rename',
          integrationId: 'provider',
          accountId: 'account',
          label: 'New',
        })
        if (success) await request
        else await expect(request).rejects.toThrow('Rename not confirmed')
      })
      await waitFor(() => expect(result.current.query.data?.accounts[0]?.label).toBe('Current'))
      expect(client.getQueryState(['provider-credentials'])?.isInvalidated).toBe(true)
      expect(providerAccountsApi.rename).toHaveBeenCalledExactlyOnceWith('provider', 'account', 'New')
    } finally {
      unmount()
      client.clear()
    }
  })
})
