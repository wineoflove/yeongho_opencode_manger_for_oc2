import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FetchError } from '@opencode-manager/shared'
import { claudeProxyApi, type ClaudeProxyLogin } from '@/api/claudeProxy'
import { showToast } from '@/lib/toast'
import { ProxyAddAccountDialog } from './ProxyAddAccountDialog'

vi.mock('@/api/claudeProxy', () => ({
  claudeProxyApi: {
    accounts: vi.fn(),
    startLogin: vi.fn(),
    completeLogin: vi.fn(),
  },
}))
vi.mock('@/lib/toast', () => ({ showToast: { success: vi.fn() } }))

const REDIRECT = 'http://localhost:54545/callback?code=one-time&state=state-1'

function signIn(state: string, expiresAt: number): ClaudeProxyLogin {
  return {
    provider: 'claude',
    state,
    url: `https://claude.ai/oauth/authorize?state=${state}`,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

function renderDialog() {
  const onClose = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <ProxyAddAccountDialog provider="claude" onClose={onClose} />
    </QueryClientProvider>,
  )
  return { client, onClose, unmount: view.unmount }
}

describe('ProxyAddAccountDialog', () => {
  let openWindow: MockInstance<typeof window.open>

  beforeEach(() => {
    vi.clearAllMocks()
    openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    openWindow.mockRestore()
  })

  it('opens the sign-in page, registers the pasted address, then closes without keeping it', async () => {
    vi.mocked(claudeProxyApi.startLogin).mockResolvedValue(signIn('state-1', Date.now() + 600_000))
    let finish = () => {}
    vi.mocked(claudeProxyApi.completeLogin).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'ok' })
        }),
    )
    const { client, onClose, unmount } = renderDialog()
    const user = userEvent.setup()

    const address = screen.getByLabelText('Address after sign-in')
    expect(address).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Register account' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    await waitFor(() =>
      expect(openWindow).toHaveBeenCalledWith(
        'https://claude.ai/oauth/authorize?state=state-1',
        '_blank',
        'noopener,noreferrer',
      ),
    )
    expect(vi.mocked(claudeProxyApi.startLogin).mock.calls[0]?.[0]).toBe('claude')
    expect(screen.getByRole('link', { name: 'Open sign-in page again' })).toHaveAttribute(
      'href',
      'https://claude.ai/oauth/authorize?state=state-1',
    )
    expect(address).toBeEnabled()

    await user.type(address, REDIRECT)
    await user.click(screen.getByRole('button', { name: 'Register account' }))
    expect(screen.getByRole('button', { name: 'Registering account…' })).toBeDisabled()
    expect(vi.mocked(claudeProxyApi.completeLogin).mock.calls[0]?.[0]).toEqual({
      provider: 'claude',
      state: 'state-1',
      redirectUrl: REDIRECT,
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => finish())
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(showToast.success).toHaveBeenCalledWith('Claude account added')

    unmount()
    await waitFor(() => expect(client.getMutationCache().getAll()).toEqual([]))
  })

  it('keeps the dialog open with a friendly message when the pasted address is not the sign-in redirect', async () => {
    vi.mocked(claudeProxyApi.startLogin).mockResolvedValue(signIn('state-1', Date.now() + 600_000))
    vi.mocked(claudeProxyApi.completeLogin).mockRejectedValue(
      new FetchError('private-upstream-detail', 400, 'INVALID_REDIRECT'),
    )
    const { onClose } = renderDialog()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    const address = screen.getByLabelText('Address after sign-in')
    await waitFor(() => expect(address).toBeEnabled())
    await user.type(address, 'https://example.com/elsewhere')
    await user.click(screen.getByRole('button', { name: 'Register account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is not the address from the sign-in page. After signing in, copy the full URL from the address bar.',
    )
    expect(address).toHaveValue('https://example.com/elsewhere')
    expect(screen.getByRole('button', { name: 'Register account' })).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast.success).not.toHaveBeenCalled()
    expect(screen.queryByText(/private-upstream-detail/)).not.toBeInTheDocument()
  })

  it('counts down to the link expiry, then blocks registration until a new link is made', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T09:00:00.000Z'))
    vi.mocked(claudeProxyApi.startLogin)
      .mockResolvedValueOnce(signIn('state-1', Date.now() + 120_000))
      .mockImplementationOnce(async () => signIn('state-2', Date.now() + 120_000))
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Expires in 2:00')).toBeInTheDocument()
    const address = screen.getByLabelText('Address after sign-in')
    fireEvent.change(address, { target: { value: REDIRECT } })
    expect(screen.getByRole('button', { name: 'Register account' })).toBeEnabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(screen.getByText('Expires in 0:59')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('This sign-in link has expired.')
    expect(screen.getByRole('button', { name: 'Register account' })).toBeDisabled()
    expect(address).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Create a new link' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(claudeProxyApi.startLogin).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Expires in 2:00')).toBeInTheDocument()
    expect(address).toBeEnabled()
    expect(address).toHaveValue('')
    expect(claudeProxyApi.completeLogin).not.toHaveBeenCalled()
  })
})
