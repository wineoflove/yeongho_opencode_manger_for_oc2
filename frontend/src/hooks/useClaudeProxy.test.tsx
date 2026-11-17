import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyApi } from '@/api/claudeProxy'
import { useClaudeProxy } from './useClaudeProxy'

vi.mock('@/api/claudeProxy', () => ({
  claudeProxyApi: { status: vi.fn(), accounts: vi.fn() },
}))
afterEach(() => vi.resetAllMocks())

function fixture() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderHook(() => useClaudeProxy(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

describe('Claude management ownership state', () => {
  it('does not request proxy accounts in native mode', async () => {
    vi.mocked(claudeProxyApi.status).mockResolvedValue({
      configured: false,
      ownsInference: false,
    })
    const view = fixture()
    try {
      await waitFor(() => expect(view.result.current.ownership).toBe('native'))
      expect(claudeProxyApi.accounts).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })
  it('does not revert to native when account management fails', async () => {
    vi.mocked(claudeProxyApi.status).mockResolvedValue({
      configured: true,
      ownsInference: true,
    })
    vi.mocked(claudeProxyApi.accounts).mockRejectedValue(new Error('management-unavailable'))
    const view = fixture()
    try {
      await waitFor(() => expect(view.result.current.accounts.isError).toBe(true))
      expect(view.result.current.ownership).toBe('proxy')
    } finally {
      view.unmount()
    }
  })
  it('does not trust stale native ownership after a failed status refresh', async () => {
    vi.mocked(claudeProxyApi.status)
      .mockResolvedValueOnce({ configured: false, ownsInference: false })
      .mockRejectedValue(new Error('status-unavailable'))
    const view = fixture()
    try {
      await waitFor(() => expect(view.result.current.ownership).toBe('native'))
      await act(async () => {
        await view.result.current.status.refetch()
      })
      await waitFor(() => expect(view.result.current.ownership).toBe('unavailable'))
    } finally {
      view.unmount()
    }
  })
})
