import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderExternalLoginResponse } from '@opencode-manager/shared/schemas'
import { providerExternalApi } from '@/api/providerExternal'
import { providerCredentialsApi } from '@/api/providers'
import { ClaudeAgentConnection } from './ClaudeAgentConnection'

vi.mock('@/api/providerExternal', () => ({
  providerExternalApi: {
    getStatus: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('@/api/providers', () => ({
  providerCredentialsApi: {
    delete: vi.fn(),
  },
}))

const connectedMessage = 'OpenCode registered the native connection. Inference has not been verified.'
const needsAuthMessage = 'OpenCode reports that Claude Code needs a sign-in on the server host.'

function loginState(status: ProviderExternalLoginResponse['status']): ProviderExternalLoginResponse {
  return {
    integrationID: 'claude-agent',
    methodID: 'claude-login',
    available: status !== 'unavailable',
    status,
    connectionScope: 'current_host_login',
    supportsMultipleAccounts: false,
    instructions: {
      command: 'claude auth login',
      location: 'opencode_host',
      message: 'Backend instruction prose',
    },
  }
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ClaudeAgentConnection />
    </QueryClientProvider>,
  )
  return client
}

describe('ClaudeAgentConnection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.each([
    { status: 'unconnected', message: 'Not connected.', connectControls: 1, removeControls: 0 },
    { status: 'needs_auth', message: needsAuthMessage, connectControls: 0, removeControls: 1 },
    { status: 'connected', message: connectedMessage, connectControls: 0, removeControls: 1 },
    { status: 'unavailable', message: 'This OpenCode server does not offer the Claude Agent connection.', connectControls: 0, removeControls: 0 },
  ] as const)(
    'reports $status for the host login with its controls, without registering, removing or asking for a key on mount',
    async ({ status, message, connectControls, removeControls }) => {
      vi.mocked(providerExternalApi.getStatus).mockResolvedValue(loginState(status))
      renderPanel()

      expect(await screen.findByText(message)).toHaveAttribute('role', 'status')
      expect(screen.queryAllByRole('button', { name: 'Use Claude Code login' })).toHaveLength(connectControls)
      expect(screen.queryAllByRole('button', { name: 'Remove connection' })).toHaveLength(removeControls)
      expect(screen.getByRole('region', { name: 'Claude Agent' }).querySelector('input, textarea')).toBeNull()
      expect(providerExternalApi.connect).not.toHaveBeenCalled()
      expect(providerCredentialsApi.delete).not.toHaveBeenCalled()
    },
  )

  it('registers on click and then shows the host CLI sign-in steps for the returned state', async () => {
    vi.mocked(providerExternalApi.getStatus).mockResolvedValue(loginState('unconnected'))
    vi.mocked(providerExternalApi.connect).mockResolvedValue(loginState('needs_auth'))
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'Use Claude Code login' }))

    expect(await screen.findByText('claude auth login')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Signing in there replaces the Claude Code login already stored for that user and environment, which other tools outside OpenCode may also use.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Backend instruction prose')).not.toBeInTheDocument()
    expect(providerExternalApi.connect).toHaveBeenCalledOnce()
  })

  it('sends a repeated click to the backend again after a failed registration', async () => {
    vi.mocked(providerExternalApi.getStatus).mockResolvedValue(loginState('unconnected'))
    vi.mocked(providerExternalApi.connect)
      .mockRejectedValueOnce(new Error('secret-upstream-detail'))
      .mockResolvedValueOnce(loginState('connected'))
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Use Claude Code login' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not register the Claude Agent connection. Refresh the status and try again.',
    )
    expect(screen.queryByText(/secret-upstream-detail/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use Claude Code login' }))

    expect(await screen.findByText(connectedMessage)).toBeInTheDocument()
    expect(providerExternalApi.connect).toHaveBeenCalledTimes(2)
  })

  it('shows a fixed message without upstream detail when the status cannot be loaded', async () => {
    vi.mocked(providerExternalApi.getStatus).mockRejectedValue(new Error('secret-upstream-detail'))
    renderPanel()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the Claude Agent status.')
    expect(screen.queryByText(/secret-upstream-detail/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use Claude Code login' })).not.toBeInTheDocument()
  })

  it('reads the host state again only when Refresh status is clicked', async () => {
    vi.mocked(providerExternalApi.getStatus)
      .mockResolvedValueOnce(loginState('needs_auth'))
      .mockResolvedValueOnce(loginState('connected'))
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText(needsAuthMessage)

    await user.click(screen.getByRole('button', { name: 'Refresh status' }))

    expect(await screen.findByText(connectedMessage)).toBeInTheDocument()
    expect(providerExternalApi.connect).not.toHaveBeenCalled()
  })

  it('removes nothing until the removal is confirmed and nothing when it is cancelled', async () => {
    vi.mocked(providerExternalApi.getStatus).mockResolvedValue(loginState('connected'))
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'Remove connection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Claude Agent connection' })
    expect(providerCredentialsApi.delete).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(providerCredentialsApi.delete).not.toHaveBeenCalled()
  })

  it('removes the claude-agent connection after confirmation and reloads the status so it can be registered again', async () => {
    vi.mocked(providerExternalApi.getStatus)
      .mockResolvedValueOnce(loginState('needs_auth'))
      .mockResolvedValue(loginState('unconnected'))
    vi.mocked(providerCredentialsApi.delete).mockResolvedValue(undefined)
    const user = userEvent.setup()
    const client = renderPanel()
    client.setQueryData(['opencode', 'providers'], { providers: [], models: [] })

    await user.click(await screen.findByRole('button', { name: 'Remove connection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Claude Agent connection' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove connection' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Not connected.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use Claude Code login' })).toBeEnabled()
    expect(providerCredentialsApi.delete).toHaveBeenCalledExactlyOnceWith('claude-agent')
    expect(client.getQueryState(['opencode', 'providers'])?.isInvalidated).toBe(true)
  })

  it('keeps the confirmation open with an error that hides upstream detail and reloads the status when removal fails', async () => {
    vi.mocked(providerExternalApi.getStatus)
      .mockResolvedValueOnce(loginState('connected'))
      .mockResolvedValue(loginState('unconnected'))
    vi.mocked(providerCredentialsApi.delete).mockRejectedValue(new Error('secret-upstream-detail'))
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'Remove connection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Claude Agent connection' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove connection' }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Remove Claude Agent connection' })).toBe(dialog)
    expect(screen.queryByText(/secret-upstream-detail/)).not.toBeInTheDocument()
    expect(screen.getByText('Not connected.')).toBeInTheDocument()
  })
})
