import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/api/provider-accounts', () => ({
  providerAccountsApi: { list: vi.fn(async () => ({ accounts: [] })) },
}))
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderSettings } from './ProviderSettings'
import { claudeProxyApi } from '@/api/claudeProxy'
vi.mock('@/api/claudeProxy', () => ({
  claudeProxyApi: { status: vi.fn(), accounts: vi.fn() },
}))
import { getProviders, providerCredentialsApi } from '@/api/providers'
import { oauthApi } from '@/api/oauth'
import { providerAccountsApi } from '@/api/provider-accounts'
import type { Provider } from '@/api/providers'
import type { IntegrationMethod, OAuthAuthorizeResponse } from '@/api/oauth'
import type { ProviderAccount } from '@opencode-manager/shared/schemas'
import { FetchError } from '@opencode-manager/shared'
import type { ClaudeProxyAccount } from '@/api/claudeProxy'

vi.mock('@/api/providers', () => ({
  getProviders: vi.fn(),
  providerCredentialsApi: {
    list: vi.fn(),
    getStatus: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/api/oauth', () => ({
  oauthApi: {
    getAuthMethods: vi.fn(),
    authorize: vi.fn(),
    callback: vi.fn(),
  },
}))

vi.mock('./OAuthAuthorizeDialog', () => ({
  OAuthAuthorizeDialog: ({
    open,
    providerId,
    hasAccounts,
  }: {
    open: boolean
    providerId: string
    providerName: string
    methods: unknown[]
    hasAccounts: boolean
    onOpenChange: (open: boolean) => void
    onSuccess: (response: OAuthAuthorizeResponse, methodID: string) => void
  }) =>
    open ? (
      <div data-testid="oauth-authorize-dialog" data-has-accounts={String(hasAccounts)}>
        {providerId}
      </div>
    ) : null,
}))

vi.mock('./OAuthCallbackDialog', () => ({
  OAuthCallbackDialog: ({
    open,
    providerId,
  }: {
    open: boolean
    providerId: string
    providerName: string
    authResponse: OAuthAuthorizeResponse
    onOpenChange: (open: boolean) => void
    onSuccess: () => void
  }) => (open ? <div data-testid="oauth-callback-dialog">{providerId}</div> : null),
}))

vi.mock('./ProviderRateLimits', () => ({
  ProviderRateLimits: ({ providerId }: { readonly providerId: string }) => (
    <div data-testid="provider-rate-limits" data-provider-id={providerId} />
  ),
}))

vi.mock('./ClaudeAgentConnection', () => ({
  ClaudeAgentConnection: () => <section data-testid="claude-agent-connection" />,
}))

vi.mock('@/components/model/ApiKeyDialog', () => ({
  ApiKeyDialog: ({
    open,
    hasAccounts,
    provider,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    provider: {
      id: string
      name: string
      models: { id: string; name: string }[]
    }
    onSuccess: () => void
    hasAccounts: boolean
  }) =>
    open ? (
      <div data-testid="api-key-dialog" data-has-accounts={String(hasAccounts)}>
        {provider.name}
      </div>
    ) : null,
}))

function providerFixture(id: string, name: string, modelCount: number): Provider {
  return {
    id,
    name,
    models: Array.from({ length: modelCount }, (_, index) => ({
      id: `model-${index}`,
      name: `model-${index}`,
      released: 0,
      free: false,
    })),
  }
}

const mixedProviderWithAccounts = providerFixture('openai', 'OpenAI', 2)
const oauthProviderWithoutAccounts = providerFixture('google', 'Google', 3)
const keyProviderWithAccounts = providerFixture('anthropic', 'Anthropic', 1)
const keyProviderWithoutAccounts = providerFixture('together', 'Together AI', 4)

const openAIMethods: IntegrationMethod[] = [
  { id: 'fixture-chatgpt-login', type: 'oauth', label: 'ChatGPT Pro/Plus' },
  { type: 'key', label: 'Manually enter API Key' },
]

function mockProviderData() {
  vi.mocked(getProviders).mockResolvedValue({
    providers: [
      mixedProviderWithAccounts,
      oauthProviderWithoutAccounts,
      keyProviderWithAccounts,
      keyProviderWithoutAccounts,
    ],
    models: [],
  })
  vi.mocked(providerCredentialsApi.list).mockResolvedValue(['openai', 'anthropic'])
  vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
    openai: openAIMethods,
    google: [{ id: 'oauth', type: 'oauth', label: 'OAuth' }],
    anthropic: [{ type: 'key', label: 'API key' }],
  })
  vi.mocked(providerAccountsApi.list).mockResolvedValue({ accounts: [] })
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderSettings />
    </QueryClientProvider>,
  )
}

function proxyAccount(
  fields: Pick<ClaudeProxyAccount, 'id' | 'provider'> & Partial<ClaudeProxyAccount>,
): ClaudeProxyAccount {
  return {
    label: null,
    enabled: true,
    available: true,
    successCount: 0,
    failureCount: 0,
    lastRefreshedAt: null,
    nextRetryAt: null,
    ...fields,
  }
}

function mockProxyOwnership(accounts: ClaudeProxyAccount[]) {
  vi.mocked(claudeProxyApi.status).mockResolvedValue({
    configured: true,
    ownsInference: true,
  })
  vi.mocked(claudeProxyApi.accounts).mockResolvedValue({
    configured: true,
    observedAt: '2026-11-12T08:00:00Z',
    accounts,
  })
}

async function openDirectLogin(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole('button', {
    name: 'Direct login (advanced)',
  })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  if (!content) throw new Error('Direct login content is not controlled by its toggle')
  return content
}

describe('ProviderSettings', () => {
  it('uses the authentication integration for accounts, adding and removing all while quota keeps the provider ID', async () => {
    vi.mocked(getProviders).mockResolvedValue({
      providers: [
        {
          ...providerFixture('model-provider', 'Model provider', 1),
          integrationID: 'auth-provider',
        },
      ],
      models: [],
    })
    vi.mocked(providerCredentialsApi.list).mockResolvedValue(['auth-provider'])
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
      'auth-provider': [{ id: 'oauth', type: 'oauth', label: 'OAuth' }],
    })
    renderSettings()
    const user = userEvent.setup()
    await screen.findByText('Model provider')
    await waitFor(() => expect(providerAccountsApi.list).toHaveBeenCalledWith('auth-provider'))
    expect(screen.getByTestId('provider-rate-limits')).toHaveAttribute('data-provider-id', 'model-provider')
    await user.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByTestId('oauth-authorize-dialog')).toHaveTextContent('auth-provider')
    await user.click(screen.getByRole('button', { name: 'Remove all accounts' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove all accounts for Model provider',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Remove all accounts' }))
    await waitFor(() => expect(providerCredentialsApi.delete).toHaveBeenCalledWith('auth-provider'))
  })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claudeProxyApi.status).mockResolvedValue({
      configured: false,
      ownsInference: false,
    })
    mockProviderData()
  })
  it('makes the CLIProxy accounts the primary surface and keeps direct login closed', async () => {
    mockProxyOwnership([
      proxyAccount({
        id: 'aa47ac1b75dc0765',
        provider: 'claude',
        label: 'work@example.com',
      }),
      proxyAccount({
        id: 'bb47ac1b75dc0765',
        provider: 'claude',
        available: false,
      }),
      proxyAccount({
        id: 'cc47ac1b75dc0765',
        provider: 'openai',
        label: 'chatgpt@example.com',
      }),
    ])
    renderSettings()

    const claude = await screen.findByRole('region', { name: 'Claude' })
    expect(within(claude).getByText('work@example.com')).toBeInTheDocument()
    expect(within(claude).getByText('Account 2')).toBeInTheDocument()
    expect(within(claude).getByText('1/2 available')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'OpenAI' })).getByText('chatgpt@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Direct login (advanced)' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('heading', { name: 'OAuth Providers' })).not.toBeInTheDocument()
    expect(getProviders).not.toHaveBeenCalled()
  })
  it('removes Anthropic and OpenAI from the direct sign-ins under CLIProxy ownership', async () => {
    mockProxyOwnership([])
    const user = userEvent.setup()
    renderSettings()

    const direct = await openDirectLogin(user)
    expect(await within(direct).findByText('Google')).toBeInTheDocument()
    expect(
      within(direct).getByText(
        "Accounts signed in here do not go through CLIProxy. Manage Claude and OpenAI accounts in 'AI accounts' above.",
      ),
    ).toBeInTheDocument()
    expect(within(direct).getByText('Managed in CLIProxy: OpenAI, Anthropic')).toBeInTheDocument()
    await user.click(within(direct).getByRole('button', { name: /^Connected/ }))
    expect(within(direct).queryByText('OpenAI', { exact: true })).not.toBeInTheDocument()
    expect(within(direct).queryByText('Anthropic', { exact: true })).not.toBeInTheDocument()
    expect(within(direct).getByText('Together AI')).toBeInTheDocument()
    expect(within(direct).queryByTestId('claude-agent-connection')).not.toBeInTheDocument()
  })
  it('keeps direct Claude and OpenAI sign-ins hidden when CLIProxy ownership cannot be confirmed', async () => {
    vi.mocked(claudeProxyApi.status).mockRejectedValue(new Error('ownership-unavailable'))
    const user = userEvent.setup()
    renderSettings()

    expect(
      await screen.findByText(
        'Could not confirm whether CLIProxy manages the AI accounts. Direct Claude and OpenAI sign-ins stay hidden until it is confirmed.',
      ),
    ).toBeInTheDocument()
    const direct = await openDirectLogin(user)
    expect(await within(direct).findByText('Google')).toBeInTheDocument()
    expect(within(direct).queryByText('OpenAI', { exact: true })).not.toBeInTheDocument()
    expect(claudeProxyApi.accounts).not.toHaveBeenCalled()
  })
  it('explains a CLIProxy account list failure without upstream detail', async () => {
    vi.mocked(claudeProxyApi.status).mockResolvedValue({
      configured: true,
      ownsInference: true,
    })
    vi.mocked(claudeProxyApi.accounts).mockRejectedValue(new FetchError('private-upstream-detail', 502, 'UNAVAILABLE'))
    renderSettings()

    expect(await screen.findByText('Could not reach CLIProxy. Try again in a moment.')).toBeInTheDocument()
    expect(screen.queryByText(/private-upstream-detail/)).not.toBeInTheDocument()
  })
  it('shows the direct sign-ins expanded without the CLIProxy section when OpenCode owns the accounts', async () => {
    renderSettings()

    expect(await screen.findByRole('heading', { name: 'OAuth Providers' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AI accounts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Direct login (advanced)' })).not.toBeInTheDocument()
    expect(claudeProxyApi.accounts).not.toHaveBeenCalled()
  })

  it('lays out OAuth and API key columns in a container-query grid that splits at 1000px of content width', async () => {
    const { container } = renderSettings()

    await screen.findByText('OpenAI')

    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass('@container', 'w-full', 'max-w-7xl')

    const layout = root.firstElementChild as HTMLElement
    expect(layout).toHaveClass('grid', '@min-[1000px]:grid-cols-2', '@min-[1000px]:items-start')

    const [oauthColumn, apiKeysColumn] = Array.from(layout.children) as HTMLElement[]
    expect(oauthColumn).toHaveClass('min-w-0')
    expect(within(oauthColumn).getByRole('heading', { name: 'OAuth Providers' })).toBeInTheDocument()
    expect(apiKeysColumn).toHaveClass('min-w-0')
    expect(within(apiKeysColumn).getByRole('heading', { name: 'API Keys' })).toBeInTheDocument()
  })

  it('renders OAuth providers as compact divider rows with the name, model count, status, and actions', async () => {
    const { container } = renderSettings()

    await screen.findByText('OpenAI')

    const rows = container.querySelector('.divide-y') as HTMLElement
    expect(rows).toHaveClass('divide-border')

    const connectedRow = screen.getByText('OpenAI').closest('.py-3') as HTMLElement
    expect(connectedRow).toHaveClass('flex-wrap')
    expect(within(connectedRow).getByText('2 models')).toBeInTheDocument()
    expect(within(connectedRow).getByText('Connected')).toBeInTheDocument()
    expect(within(connectedRow).getByRole('button', { name: 'Add account' })).toBeInTheDocument()
    expect(within(connectedRow).getByRole('button', { name: 'Add API key' })).toBeInTheDocument()
    expect(within(connectedRow).getByRole('button', { name: 'Remove all accounts' })).toBeInTheDocument()

    const disconnectedRow = screen.getByText('Google').closest('.py-3') as HTMLElement
    expect(within(disconnectedRow).getByText('3 models')).toBeInTheDocument()
    expect(within(disconnectedRow).getByText('Not Connected')).toBeInTheDocument()
    expect(within(disconnectedRow).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(within(disconnectedRow).queryByRole('button', { name: 'Add API key' })).not.toBeInTheDocument()
    expect(
      within(disconnectedRow).queryByRole('button', {
        name: 'Remove all accounts',
      }),
    ).not.toBeInTheDocument()
  })

  it('expands Available Providers by default so the search is visible immediately', async () => {
    renderSettings()

    await screen.findByText('Together AI')

    expect(screen.getByPlaceholderText('Search providers...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Available Providers/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Connected/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the Connected disclosure collapsed and labels its icon-only key actions', async () => {
    const user = userEvent.setup()
    renderSettings()

    await screen.findByText('OpenAI')

    expect(screen.queryByText('Anthropic')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Connected/ }))

    const connectedCard = screen.getByText('Anthropic').closest('.bg-card') as HTMLElement
    expect(
      within(connectedCard).getByRole('button', {
        name: 'Add another API key for Anthropic',
      }),
    ).toBeInTheDocument()
    expect(
      within(connectedCard).getByRole('button', {
        name: 'Remove all accounts for Anthropic',
      }),
    ).toBeInTheDocument()
  })

  it('filters the available provider search list and gives it the taller scroll area', async () => {
    vi.mocked(getProviders).mockResolvedValue({
      providers: [keyProviderWithoutAccounts, providerFixture('mistral', 'Mistral', 2)],
      models: [],
    })
    const user = userEvent.setup()
    const { container } = renderSettings()

    await screen.findByText('Together AI')

    const list = container.querySelector('.max-h-96') as HTMLElement
    expect(list).toBeInTheDocument()
    expect(within(list).getByText('Mistral')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search providers...'), 'together')

    expect(within(list).getByText('Together AI')).toBeInTheDocument()
    expect(within(list).queryByText('Mistral')).not.toBeInTheDocument()
  })

  it('opens the OAuth authorize dialog for a first account when Connect is chosen', async () => {
    const user = userEvent.setup()
    renderSettings()

    await screen.findByText('Google')

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    const dialog = screen.getByTestId('oauth-authorize-dialog')
    expect(dialog).toHaveTextContent('google')
    expect(dialog).toHaveAttribute('data-has-accounts', 'false')
  })

  it('offers OAuth and API key additions for a connected mixed integration while its accounts stay listed', async () => {
    vi.mocked(providerAccountsApi.list).mockImplementation(async (integrationId) => ({
      accounts:
        integrationId === 'openai'
          ? [
              {
                id: 'fixture-openai-account',
                integrationID: 'openai',
                label: 'Work ChatGPT',
                active: true,
                type: 'oauth',
                methodID: 'fixture-chatgpt-login',
              },
            ]
          : [],
    }))
    const user = userEvent.setup()
    renderSettings()

    const row = (await screen.findByText('Work ChatGPT')).closest('.py-3') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Delete account Work ChatGPT' })).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Add account' }))
    const oauthDialog = screen.getByTestId('oauth-authorize-dialog')
    expect(oauthDialog).toHaveTextContent('openai')
    expect(oauthDialog).toHaveAttribute('data-has-accounts', 'true')

    await user.click(within(row).getByRole('button', { name: 'Add API key' }))
    const apiKeyDialog = screen.getByTestId('api-key-dialog')
    expect(apiKeyDialog).toHaveTextContent('OpenAI')
    expect(apiKeyDialog).toHaveAttribute('data-has-accounts', 'true')
    expect(within(row).getByText('Work ChatGPT')).toBeInTheDocument()
  })

  it('opens the API key dialog for a first key from the available list', async () => {
    const user = userEvent.setup()
    renderSettings()

    await screen.findByText('Together AI')

    await user.click(screen.getByRole('button', { name: 'Add Key' }))

    const dialog = screen.getByTestId('api-key-dialog')
    expect(dialog).toHaveAttribute('data-has-accounts', 'false')
    expect(dialog).toHaveTextContent('Together AI')
  })

  it('adds another API key to a connected key-only provider instead of editing its existing key', async () => {
    const user = userEvent.setup()
    renderSettings()

    await screen.findByText('OpenAI')

    await user.click(screen.getByRole('button', { name: /Connected/ }))
    await user.click(screen.getByRole('button', { name: 'Add another API key for Anthropic' }))

    const dialog = screen.getByTestId('api-key-dialog')
    expect(dialog).toHaveAttribute('data-has-accounts', 'true')
    expect(dialog).toHaveTextContent('Anthropic')
  })

  it.each([
    [
      'POOL_ACCOUNT_IN_USE',
      'Remove the referenced accounts from the pool configuration first. No accounts were deleted.',
    ],
    ['POOL_CONFIG_UNAVAILABLE', 'The pool configuration could not be checked. No accounts were deleted.'],
  ])('explains remove-all rejection without exposing upstream details: %s', async (code, message) => {
    const user = userEvent.setup()
    vi.mocked(providerCredentialsApi.delete).mockRejectedValue(new FetchError('private-fixture', 409, code))
    renderSettings()
    await screen.findByText('OpenAI')
    await user.click(screen.getByRole('button', { name: 'Remove all accounts' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove all accounts for OpenAI',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Remove all accounts' }))
    expect(await within(dialog).findByText(message)).toHaveAttribute('role', 'alert')
    expect(screen.queryByText('private-fixture')).not.toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('removes all accounts only after a confirmation that says every account is removed, then closes it', async () => {
    const user = userEvent.setup()
    vi.mocked(providerCredentialsApi.delete).mockResolvedValue(undefined)
    renderSettings()

    await screen.findByText('OpenAI')

    await user.click(screen.getByRole('button', { name: 'Remove all accounts' }))
    let dialog = await screen.findByRole('dialog', {
      name: 'Remove all accounts for OpenAI',
    })
    expect(
      within(dialog).getByText(
        'This removes every saved account for OpenAI, including the selected account. To remove only one account, use Delete next to that account.',
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(providerCredentialsApi.delete).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove all accounts' }))
    dialog = await screen.findByRole('dialog', {
      name: 'Remove all accounts for OpenAI',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Remove all accounts' }))

    await waitFor(() => {
      expect(providerCredentialsApi.delete).toHaveBeenCalledExactlyOnceWith('openai')
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the remove-all confirmation open with an error that hides upstream detail and reloads the remaining accounts when removal fails', async () => {
    const account = (id: string, label: string, active: boolean): ProviderAccount => ({
      id,
      integrationID: 'openai',
      label,
      active,
      type: 'oauth',
      methodID: 'fixture-chatgpt-login',
    })
    let openAIAccounts = [
      account('fixture-work', 'Work ChatGPT', true),
      account('fixture-personal', 'Personal ChatGPT', false),
    ]
    vi.mocked(providerAccountsApi.list).mockImplementation(async (integrationId) => ({
      accounts: integrationId === 'openai' ? openAIAccounts : [],
    }))
    vi.mocked(providerCredentialsApi.delete).mockImplementationOnce(async () => {
      openAIAccounts = openAIAccounts.filter((entry) => entry.id !== 'fixture-work')
      throw new Error('secret-upstream-detail')
    })
    const user = userEvent.setup()
    renderSettings()
    await screen.findByText('Work ChatGPT')

    await user.click(screen.getByRole('button', { name: 'Remove all accounts' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove all accounts for OpenAI',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Remove all accounts' }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Remove all accounts for OpenAI' })).toBe(dialog)
    expect(screen.queryByText(/secret-upstream-detail/)).not.toBeInTheDocument()
    expect(screen.queryByText('Work ChatGPT')).not.toBeInTheDocument()
    expect(screen.getByText('Personal ChatGPT')).toBeInTheDocument()
  })

  it('shows the empty state when no OAuth-capable providers exist', async () => {
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({})
    renderSettings()

    await screen.findByText('No OAuth-capable providers available.')

    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument()
  })

  it('keeps the Claude Agent panel when the model catalog is empty', async () => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [], models: [] })
    vi.mocked(providerCredentialsApi.list).mockResolvedValue([])
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({})
    renderSettings()

    expect(await screen.findByTestId('claude-agent-connection')).toBeInTheDocument()
  })

  it.each<{ readonly credentials: string[] }>([{ credentials: [] }, { credentials: ['claude-agent'] }])(
    'keeps the claude-agent integration out of the API key lists when its credentials are $credentials',
    async ({ credentials }) => {
      vi.mocked(getProviders).mockResolvedValue({
        providers: [
          {
            ...providerFixture('claude-agent-models', 'Claude Agent', 2),
            integrationID: 'claude-agent',
          },
          keyProviderWithoutAccounts,
        ],
        models: [],
      })
      vi.mocked(providerCredentialsApi.list).mockResolvedValue(credentials)
      vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
        'claude-agent': [{ id: 'claude-login', type: 'external', label: 'Claude Code' }],
      })
      const user = userEvent.setup()
      renderSettings()

      await screen.findByText('Together AI')
      await user.click(screen.getByRole('button', { name: /Connected/ }))

      expect(screen.queryByText('Claude Agent')).not.toBeInTheDocument()
    },
  )
})
vi.mock('@/api/providerPool', () => ({
  getProviderPool: async () => ({ supported: false }),
}))
