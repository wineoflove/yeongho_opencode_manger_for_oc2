import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FetchError } from '@opencode-manager/shared'
import { claudeProxyApi, type ClaudeProxyAccount } from '@/api/claudeProxy'
import { useClaudeProxy } from '@/hooks/useClaudeProxy'
import { ProxyAccountsSection } from './ProxyAccountsSection'

vi.mock('@/api/claudeProxy', () => ({
  claudeProxyApi: {
    status: vi.fn(),
    accounts: vi.fn(),
    setAccountEnabled: vi.fn(),
    deleteAccount: vi.fn(),
    startLogin: vi.fn(),
    completeLogin: vi.fn(),
  },
}))

const WORK = 'aa47ac1b75dc0765'
const HOME = 'bb47ac1b75dc0765'

let serverAccounts: ClaudeProxyAccount[] = []

function account(fields: Pick<ClaudeProxyAccount, 'id' | 'label'> & Partial<ClaudeProxyAccount>): ClaudeProxyAccount {
  return {
    provider: 'claude',
    enabled: true,
    available: true,
    successCount: 4,
    failureCount: 1,
    lastRefreshedAt: null,
    nextRetryAt: null,
    ...fields,
  }
}

function applyEnabled(id: string, enabled: boolean) {
  serverAccounts = serverAccounts.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
}

function Section() {
  return <ProxyAccountsSection proxy={useClaudeProxy()} />
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Section />
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

describe('ProxyAccountsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claudeProxyApi.status).mockResolvedValue({
      configured: true,
      ownsInference: true,
    })
    vi.mocked(claudeProxyApi.accounts).mockImplementation(async () => ({
      configured: true,
      observedAt: '2026-11-12T08:00:00Z',
      accounts: serverAccounts,
    }))
    vi.mocked(claudeProxyApi.setAccountEnabled).mockImplementation(async (id, enabled) => {
      applyEnabled(id, enabled)
      return { status: 'ok' }
    })
    vi.mocked(claudeProxyApi.deleteAccount).mockImplementation(async (id) => {
      serverAccounts = serverAccounts.filter((entry) => entry.id !== id)
      return { status: 'ok' }
    })
  })

  it('turns an account off directly while another account still serves, locking the controls until the list reloads', async () => {
    serverAccounts = [
      account({ id: WORK, label: 'work@example.com' }),
      account({ id: HOME, label: 'home@example.com' }),
    ]
    let release = () => {}
    vi.mocked(claudeProxyApi.setAccountEnabled).mockImplementation(
      (id, enabled) =>
        new Promise((resolve) => {
          release = () => {
            applyEnabled(id, enabled)
            resolve({ status: 'ok' })
          }
        }),
    )
    const user = renderSection()

    const toggle = await screen.findByRole('switch', {
      name: 'Include work@example.com in rotation',
    })
    const other = screen.getByRole('switch', {
      name: 'Include home@example.com in rotation',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(claudeProxyApi.setAccountEnabled).toHaveBeenCalledExactlyOnceWith(WORK, false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(other).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete work@example.com' })).toBeDisabled()

    act(() => release())
    await waitFor(() => expect(other).toBeEnabled())
    expect(within(toggle.closest('li') as HTMLElement).getByText('Inactive')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByText('1/2 available')).toBeInTheDocument()
  })

  it('asks before turning off the last enabled account and sends nothing until confirmed', async () => {
    serverAccounts = [
      account({ id: WORK, label: 'work@example.com' }),
      account({
        id: HOME,
        label: 'home@example.com',
        enabled: false,
        available: false,
      }),
    ]
    const user = renderSection()

    const toggle = await screen.findByRole('switch', {
      name: 'Include work@example.com in rotation',
    })
    await user.click(toggle)
    let dialog = await screen.findByRole('dialog', {
      name: 'Turn off work@example.com?',
    })
    expect(
      within(dialog).getByText(
        'This is the last enabled Claude account. While it is off, Claude requests fail until you add or enable another account.',
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(claudeProxyApi.setAccountEnabled).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)
    dialog = await screen.findByRole('dialog', {
      name: 'Turn off work@example.com?',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(claudeProxyApi.setAccountEnabled).toHaveBeenCalledExactlyOnceWith(WORK, false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('warns only when the deleted account is the last enabled one, and deletes after confirmation', async () => {
    serverAccounts = [
      account({ id: WORK, label: 'work@example.com' }),
      account({
        id: HOME,
        label: 'home@example.com',
        enabled: false,
        available: false,
      }),
    ]
    const user = renderSection()
    const lastWarning =
      'This is the last enabled Claude account. After it is deleted, Claude requests fail until you add or enable another account.'

    await user.click(await screen.findByRole('button', { name: 'Delete home@example.com' }))
    let dialog = await screen.findByRole('dialog', {
      name: 'Delete home@example.com',
    })
    expect(within(dialog).queryByText(lastWarning)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'Delete work@example.com' }))
    dialog = await screen.findByRole('dialog', {
      name: 'Delete work@example.com',
    })
    expect(
      within(dialog).getByText('This removes the account from CLIProxy. To use it again, you need to sign in again.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(lastWarning)).toBeInTheDocument()
    expect(claudeProxyApi.deleteAccount).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(claudeProxyApi.deleteAccount).toHaveBeenCalledExactlyOnceWith(WORK)
    expect(screen.queryByText('work@example.com')).not.toBeInTheDocument()
    expect(screen.getByText('home@example.com')).toBeInTheDocument()
  })

  it('explains a failed change without upstream detail and keeps showing the server state', async () => {
    serverAccounts = [
      account({ id: WORK, label: 'work@example.com' }),
      account({ id: HOME, label: 'home@example.com' }),
    ]
    vi.mocked(claudeProxyApi.setAccountEnabled).mockRejectedValue(
      new FetchError('private-upstream-detail', 404, 'ACCOUNT_NOT_FOUND'),
    )
    const user = renderSection()

    const toggle = await screen.findByRole('switch', {
      name: 'Include work@example.com in rotation',
    })
    await user.click(toggle)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account no longer exists in CLIProxy. The list has been refreshed.',
    )
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/private-upstream-detail/)).not.toBeInTheDocument()
  })

  it('offers an add action in an empty provider card that opens the sign-in for that provider', async () => {
    serverAccounts = [account({ id: WORK, label: 'work@example.com' })]
    const user = renderSection()

    const openai = await screen.findByRole('region', { name: 'OpenAI' })
    expect(within(openai).getByText('No OpenAI accounts are registered yet.')).toBeInTheDocument()
    expect(within(openai).getByText('0/0 available')).toBeInTheDocument()
    await user.click(within(openai).getByRole('button', { name: 'Add account' }))

    expect(await screen.findByRole('dialog', { name: 'Add OpenAI account' })).toBeInTheDocument()
  })
})
