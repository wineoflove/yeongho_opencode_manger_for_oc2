import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProviderPool } from '@/api/providerPool'
import { providerAccountsApi } from '@/api/provider-accounts'
import { ProviderAccounts } from './ProviderAccounts'

vi.mock('@/api/providerPool', () => ({ getProviderPool: vi.fn() }))
vi.mock('@/api/provider-accounts', () => ({
  providerAccountsApi: {
    list: vi.fn(),
    activate: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}))

const accounts = ['A', 'B', 'C'].map((id) => ({
  id,
  integrationID: 'auth-provider',
  label: id,
  active: id === 'A',
  type: 'key' as const,
  methodID: null,
}))
const state = {
  integrationID: 'auth-provider',
  enabled: true,
  strategy: 'round-robin' as const,
  paused: false,
  lastSelectedCredentialID: 'B',
  accounts: [
    {
      credentialID: 'A',
      enabled: true,
      failure: 'authentication' as const,
      authInvalid: true,
      cooldownUntil: null,
      observedAt: 1,
    },
    {
      credentialID: 'B',
      enabled: false,
      failure: null,
      authInvalid: false,
      cooldownUntil: null,
      observedAt: null,
    },
    {
      credentialID: 'C',
      enabled: true,
      failure: 'rate-limited' as const,
      authInvalid: false,
      cooldownUntil: Date.now() + 3600000,
      observedAt: 1,
    },
  ],
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ProviderAccounts integrationId="auth-provider" providerId="model-provider" />
    </QueryClientProvider>,
  )
}

describe('provider pool presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(providerAccountsApi.list).mockResolvedValue({ accounts })
    vi.mocked(getProviderPool).mockResolvedValue({
      supported: true,
      status: state,
    })
  })

  it.each([true, false])('shows request blocking for an empty or fully disabled pool: %s', async (empty) => {
    vi.mocked(getProviderPool).mockResolvedValue({
      supported: true,
      status: {
        ...state,
        accounts: empty ? [] : state.accounts.map((account) => ({ ...account, enabled: false })),
      },
    })
    show()
    expect(await screen.findByText('No pool accounts are enabled. Requests are blocked.')).toHaveAttribute(
      'role',
      'status',
    )
    expect(screen.queryByRole('button', { name: /^Use account/ })).not.toBeInTheDocument()
    expect(providerAccountsApi.activate).not.toHaveBeenCalled()
  })

  it('uses provider ID for pool status and hides manual account activation for an enabled pool', async () => {
    show()
    expect(
      await screen.findByText('Round robin is enabled. The pool selects an eligible account for each request.'),
    ).toBeInTheDocument()
    expect(getProviderPool).toHaveBeenCalledWith('model-provider')
    expect(providerAccountsApi.list).toHaveBeenCalledWith('auth-provider')
    expect(screen.queryByRole('button', { name: /^Use account/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Selected account')).not.toBeInTheDocument()
    expect(screen.getByText('Account sign-in required')).toBeInTheDocument()
    expect(screen.getByText('Pool account disabled')).toBeInTheDocument()
    expect(screen.getByText(/^Waiting until/)).toBeInTheDocument()
    expect(providerAccountsApi.activate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'reports all enabled accounts requiring sign-in without overriding a pause: %s',
    async (paused) => {
      vi.mocked(getProviderPool).mockResolvedValue({
        supported: true,
        status: {
          ...state,
          paused,
          accounts: state.accounts.map((account) =>
            account.enabled
              ? {
                  ...account,
                  authInvalid: true,
                  failure: 'authentication',
                  cooldownUntil: null,
                }
              : account,
          ),
        },
      })
      show()
      expect(
        await screen.findByText(
          paused
            ? 'Account pool paused after access denial. Automatic requests are blocked.'
            : 'All enabled pool accounts require sign-in. Requests are blocked.',
        ),
      ).toHaveAttribute('role', 'alert')
      expect(screen.queryByRole('button', { name: /^Use account/ })).not.toBeInTheDocument()
      expect(providerAccountsApi.activate).not.toHaveBeenCalled()
    },
  )

  it('shows the persisted denial pause without offering an automatic resume', async () => {
    vi.mocked(getProviderPool).mockResolvedValue({
      supported: true,
      status: {
        ...state,
        paused: true,
        accounts: state.accounts.map((entry) =>
          entry.credentialID === 'C' ? { ...entry, cooldownUntil: null } : entry,
        ),
      },
    })
    show()
    expect(
      await screen.findByText('Account pool paused after access denial. Automatic requests are blocked.'),
    ).toHaveAttribute('role', 'alert')
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
    expect(screen.getByText('Account pool is paused')).toBeInTheDocument()
    expect(screen.queryByText('Eligible for round robin')).not.toBeInTheDocument()
  })

  it('does not mislabel an unsupported server as round robin enabled', async () => {
    vi.mocked(getProviderPool).mockResolvedValue({ supported: false })
    show()
    expect(await screen.findByText('Account pooling is unavailable on this runtime.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Use account/ })).toHaveLength(2)
  })

  it('keeps the saved account list while pool lookup fails without displaying upstream details', async () => {
    vi.mocked(getProviderPool).mockRejectedValue(new Error('private-token'))
    show()
    expect(await screen.findByText('Could not load account pool status.')).toHaveAttribute('role', 'alert')
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument())
    expect(screen.queryByText('private-token')).not.toBeInTheDocument()
  })
})
