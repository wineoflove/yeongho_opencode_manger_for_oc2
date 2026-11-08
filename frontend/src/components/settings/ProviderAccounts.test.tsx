import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { providerAccountsApi } from '@/api/provider-accounts'
import { ProviderAccounts } from './ProviderAccounts'

vi.mock('@/api/provider-accounts', () => ({
  providerAccountsApi: {
    list: vi.fn(),
    activate: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}))
vi.mock('@/i18n/translate', () => ({
  t: (key: string) => key,
  template: (key: string) => key,
}))

describe('provider account list', () => {
  beforeEach(() => vi.resetAllMocks())
  it.each([true, false])(
    'requires confirmation for deletion and retains its dialog on failure: %s',
    async (success) => {
      const user = userEvent.setup()
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      })
      const account = {
        id: 'id',
        integrationID: 'provider',
        label: 'Primary',
        active: true,
        type: 'key' as const,
        methodID: null,
      }
      vi.mocked(providerAccountsApi.list).mockResolvedValue({
        accounts: [account],
      })
      if (success)
        vi.mocked(providerAccountsApi.remove).mockResolvedValue({
          success: true,
          deletedAccountId: 'id',
        })
      else vi.mocked(providerAccountsApi.remove).mockRejectedValue(new Error('private-error'))
      const { unmount } = render(
        <QueryClientProvider client={client}>
          <ProviderAccounts integrationId="provider" />
        </QueryClientProvider>,
      )
      try {
        await user.click(await screen.findByRole('button', { name: 'Delete account {name}' }))
        let dialog = await screen.findByRole('dialog', {
          name: 'Delete saved account',
        })
        expect(within(dialog).getByText('Primary')).toBeInTheDocument()
        expect(
          within(dialog).getByText(
            'Remove this selected account. OpenCode may automatically select another saved account for this provider.',
          ),
        ).toBeInTheDocument()
        expect(providerAccountsApi.remove).not.toHaveBeenCalled()
        await user.click(within(dialog).getByRole('button', { name: 'Cancel', exact: true }))
        expect(providerAccountsApi.remove).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: 'Delete account {name}' }))
        dialog = await screen.findByRole('dialog', {
          name: 'Delete saved account',
        })
        await user.click(within(dialog).getByRole('button', { name: 'Delete', exact: true }))
        await waitFor(() => expect(providerAccountsApi.remove).toHaveBeenCalledExactlyOnceWith('provider', 'id'))
        if (success) await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        else
          expect(
            await within(dialog).findByText(
              'Account deletion could not be confirmed. Review the account list before trying again.',
            ),
          ).toHaveAttribute('role', 'alert')
      } finally {
        unmount()
        client.clear()
      }
    },
  )
  it.each([true, false])(
    'changes selection only after a click and surfaces confirmation failure: %s',
    async (success) => {
      const user = userEvent.setup()
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      })
      const account = {
        id: 'id',
        integrationID: 'provider',
        label: 'Backup',
        active: false,
        type: 'key' as const,
        methodID: null,
      }
      vi.mocked(providerAccountsApi.list)
        .mockResolvedValueOnce({ accounts: [account] })
        .mockResolvedValue({ accounts: [{ ...account, active: success }] })
      const pending = Promise.withResolvers<{
        success: true
        activeAccountId: string
      }>()
      vi.mocked(providerAccountsApi.activate).mockReturnValue(pending.promise)
      const { unmount } = render(
        <QueryClientProvider client={client}>
          <ProviderAccounts integrationId="provider" />
        </QueryClientProvider>,
      )
      try {
        const button = await screen.findByRole('button', {
          name: 'Use account {name}',
        })
        expect(providerAccountsApi.activate).not.toHaveBeenCalled()
        await user.click(button)
        expect(providerAccountsApi.activate).toHaveBeenCalledExactlyOnceWith('provider', 'id')
        expect(button).toBeDisabled()
        await act(async () => {
          if (success) pending.resolve({ success: true, activeAccountId: 'id' })
          else pending.reject(new Error('secret-upstream-error'))
        })
        if (success) {
          expect(await screen.findByText('Selected account')).toBeInTheDocument()
          expect(screen.queryByRole('button', { name: 'Use account {name}' })).not.toBeInTheDocument()
        } else {
          expect(await screen.findByRole('alert')).toHaveTextContent('Account change could not be confirmed.')
          expect(screen.queryByText('secret-upstream-error')).not.toBeInTheDocument()
          await waitFor(() => expect(button).toBeEnabled())
        }
      } finally {
        pending.resolve({ success: true, activeAccountId: 'id' })
        unmount()
        client.clear()
      }
    },
  )
  it.each(['empty', 'error', 'accounts'] as const)('renders %s without changing credentials', async (state) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    if (state === 'error') vi.mocked(providerAccountsApi.list).mockRejectedValue(new Error('private-upstream-error'))
    else
      vi.mocked(providerAccountsApi.list).mockResolvedValue({
        accounts:
          state === 'empty'
            ? []
            : [
                {
                  id: 'id',
                  integrationID: 'provider',
                  label: 'Primary',
                  active: true,
                  type: 'oauth',
                  methodID: 'oauth',
                },
              ],
      })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <ProviderAccounts integrationId="provider" />
      </QueryClientProvider>,
    )
    try {
      if (state === 'empty') expect(await screen.findByText('No saved accounts for this provider.')).toBeInTheDocument()
      if (state === 'error') {
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load provider accounts.')
        expect(screen.queryByText('private-upstream-error')).not.toBeInTheDocument()
      }
      if (state === 'accounts') {
        expect(await screen.findByText('Primary')).toBeInTheDocument()
        expect(screen.getByText('Selected account')).toBeInTheDocument()
      }
      expect(providerAccountsApi.activate).not.toHaveBeenCalled()
      expect(providerAccountsApi.remove).not.toHaveBeenCalled()
    } finally {
      unmount()
      client.clear()
    }
  })
})
