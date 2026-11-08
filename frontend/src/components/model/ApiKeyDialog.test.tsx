import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiKeyDialog } from './ApiKeyDialog'
import { providerCredentialsApi } from '@/api/providers'
import { oauthApi } from '@/api/oauth'
import { FetchError } from '@/api/fetchWrapper'
import type { Provider } from '@/api/providers'

vi.mock('@/api/providers', () => ({
  providerCredentialsApi: {
    set: vi.fn(),
  },
}))

vi.mock('@/api/oauth', () => ({
  oauthApi: {
    getAuthMethods: vi.fn(),
  },
}))

function providerFixture(id: string, name: string): Provider {
  return { id, name, models: [] }
}

const azureProvider = providerFixture('azure', 'Azure')
const anthropicProvider = providerFixture('anthropic', 'Anthropic')
const openAIProvider = providerFixture('openai', 'OpenAI')

function renderDialog(provider: Provider, hasAccounts = false) {
  const onSuccess = vi.fn()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ApiKeyDialog open onOpenChange={vi.fn()} provider={provider} onSuccess={onSuccess} hasAccounts={hasAccounts} />
    </QueryClientProvider>,
  )
  return { onSuccess }
}

describe('ApiKeyDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(providerCredentialsApi.set).mockResolvedValue(undefined)
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
      azure: [
        {
          type: 'key',
          label: 'API key',
          form: [
            {
              key: 'resourceName',
              type: 'string',
              title: 'Enter Azure Resource Name',
              placeholder: 'e.g. my-models',
              required: true,
            },
          ],
        },
      ],
      anthropic: [{ type: 'key', label: 'API key' }],
      openai: [
        {
          id: 'fixture-chatgpt-login',
          type: 'oauth',
          label: 'ChatGPT Pro/Plus',
          form: [{ key: 'workspace', type: 'string', title: 'ChatGPT workspace', required: true }],
        },
        { type: 'key', label: 'Manually enter API Key' },
        { type: 'env', names: ['OPENAI_API_KEY'] },
      ],
    })
  })

  it('submits the api key alone for key methods without form fields', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog(anthropicProvider)

    await user.type(await screen.findByLabelText('API Key'), 'sk-ant-test')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(providerCredentialsApi.set).toHaveBeenCalledWith('anthropic', 'sk-ant-test', undefined)
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('adds another Anthropic key as the selected account while keeping existing accounts', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog(anthropicProvider, true)

    const dialog = await screen.findByRole('dialog', { name: 'Add Anthropic API key' })
    expect(
      within(dialog).getByText(
        'This key is saved as a new account and becomes the selected account. Existing accounts are kept.',
      ),
    ).toBeInTheDocument()
    await user.type(screen.getByLabelText('API Key'), 'sk-ant-second')
    await user.click(screen.getByRole('button', { name: 'Add Key' }))

    await waitFor(() => {
      expect(providerCredentialsApi.set).toHaveBeenCalledExactlyOnceWith('anthropic', 'sk-ant-second', undefined)
    })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('stores a key through the key method of a mixed OpenAI integration without its OAuth fields', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog(openAIProvider, true)

    expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument()
    expect(screen.queryByLabelText('ChatGPT workspace')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('API Key'), 'sk-openai-second')
    await user.click(screen.getByRole('button', { name: 'Add Key' }))

    await waitFor(() => {
      expect(providerCredentialsApi.set).toHaveBeenCalledExactlyOnceWith('openai', 'sk-openai-second', undefined)
    })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('renders required key method fields and submits their answers with the api key', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog(azureProvider)

    await user.type(await screen.findByLabelText('API Key'), 'az-test')
    await user.type(screen.getByLabelText('Enter Azure Resource Name'), 'my-models')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(providerCredentialsApi.set).toHaveBeenCalledWith('azure', 'az-test', {
        resourceName: 'my-models',
      })
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('loads form fields and stores a key using the distinct integration ID', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog({
      ...providerFixture('deployment-models', 'Deployment models'),
      integrationID: 'azure',
    })
    await user.type(await screen.findByLabelText('API Key'), 'fixture-key')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await user.type(screen.getByLabelText('Enter Azure Resource Name'), 'fixture-resource')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(providerCredentialsApi.set).toHaveBeenCalledExactlyOnceWith('azure', 'fixture-key', {
        resourceName: 'fixture-resource',
      }),
    )
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('shows only server-declared environment names for the authentication integration', async () => {
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
      'auth-provider': [{ type: 'key' }, { type: 'env', names: ['DECLARED_TOKEN'] }],
    })
    renderDialog({
      ...providerFixture('model-provider', 'Models'),
      integrationID: 'auth-provider',
    })
    expect(await screen.findByText('DECLARED_TOKEN')).toBeInTheDocument()
    expect(screen.queryByText('MODEL-PROVIDER_API_KEY')).not.toBeInTheDocument()
    expect(providerCredentialsApi.set).not.toHaveBeenCalled()
  })

  it('keeps Connect disabled until the required key method field is filled', async () => {
    const user = userEvent.setup()
    renderDialog(azureProvider)

    await user.type(await screen.findByLabelText('API Key'), 'az-test')

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()

    await user.type(screen.getByLabelText('Enter Azure Resource Name'), 'my-models')

    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('shows the upstream validation failure without reporting success', async () => {
    const user = userEvent.setup()
    vi.mocked(providerCredentialsApi.set).mockRejectedValue(
      new FetchError('Missing required form field: resourceName', 502, 'InvalidRequestError'),
    )
    const { onSuccess } = renderDialog(azureProvider)

    await user.type(await screen.findByLabelText('API Key'), 'az-test')
    await user.type(screen.getByLabelText('Enter Azure Resource Name'), 'my-models')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(
      await screen.findByText('The provider rejected the authentication details. Please check them and try again.'),
    ).toBeInTheDocument()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('keeps Connect enabled while a conditional required field is hidden and renders external fields', async () => {
    const user = userEvent.setup()
    vi.mocked(oauthApi.getAuthMethods).mockResolvedValue({
      azure: [
        {
          type: 'key',
          label: 'API key',
          form: [
            {
              key: 'deploymentType',
              type: 'string',
              title: 'Deployment',
              required: true,
              default: 'github.com',
              options: [
                { value: 'github.com', label: 'GitHub.com' },
                { value: 'enterprise', label: 'GitHub Enterprise' },
              ],
            },
            {
              key: 'enterpriseUrl',
              type: 'string',
              title: 'Enterprise URL',
              required: true,
              when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }],
            },
            {
              key: 'docs',
              type: 'external',
              url: 'https://example.com/docs',
              title: 'Read the docs',
            },
          ],
        },
      ],
    })
    renderDialog(azureProvider)

    await user.type(await screen.findByLabelText('API Key'), 'az-test')

    expect(screen.queryByLabelText('Enterprise URL')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()

    const link = screen.getByRole('link', { name: /Read the docs/ })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
