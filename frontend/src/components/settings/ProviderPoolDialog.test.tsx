import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderAccount } from '@opencode-manager/shared/schemas'
import { configureProviderPool } from '@/api/providerPool'
import { ProviderPoolDialog } from './ProviderPoolDialog'

vi.mock('@/api/providerPool', () => ({ configureProviderPool: vi.fn() }))
const accounts: ProviderAccount[] = [
  {
    id: 'a',
    integrationID: 'openai',
    label: 'Personal',
    active: true,
    type: 'oauth',
    methodID: 'method-one',
  },
  {
    id: 'b',
    integrationID: 'openai',
    label: 'Work',
    active: false,
    type: 'oauth',
    methodID: 'method-one',
  },
  {
    id: 'c',
    integrationID: 'openai',
    label: 'API key',
    active: false,
    type: 'key',
    methodID: null,
  },
]
const status = {
  integrationID: 'openai',
  enabled: false,
  strategy: null,
  paused: true,
  lastSelectedCredentialID: null,
  accounts: [],
}

function show() {
  const saved = vi.fn()
  const closed = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ProviderPoolDialog
        providerId="openai"
        accounts={accounts}
        status={status}
        revision="original-revision"
        onSaved={saved}
        onClose={closed}
      />
    </QueryClientProvider>,
  )
  return { saved, closed }
}

describe('account pool configuration dialog', () => {
  beforeEach(() => vi.resetAllMocks())

  it('allows an empty blocking pool but rejects mixed auth methods before saving', async () => {
    const user = userEvent.setup()
    show()
    expect(screen.getByRole('button', { name: 'Save pool configuration' })).toBeEnabled()
    expect(configureProviderPool).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Personal', exact: true }))
    expect(screen.getByRole('button', { name: 'Save pool configuration' })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: 'API key', exact: true }))
    expect(screen.getByRole('button', { name: 'Save pool configuration' })).toBeDisabled()
  })

  it('preserves revision and reports pending runtime application after the selected membership is saved', async () => {
    vi.mocked(configureProviderPool).mockResolvedValue({
      saved: true,
      applyStatus: 'restart_pending',
    })
    const user = userEvent.setup()
    const { saved } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Personal', exact: true }))
    await user.click(screen.getByRole('checkbox', { name: 'Work', exact: true }))
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Enable pool account Work',
        exact: true,
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Save pool configuration' }))
    await waitFor(() => expect(saved).toHaveBeenCalledWith(true))
    expect(configureProviderPool).toHaveBeenCalledWith('openai', {
      expectedRevision: 'original-revision',
      accounts: [
        { credentialID: 'a', enabled: true },
        { credentialID: 'b', enabled: false },
      ],
    })
  })

  it('keeps edits and the dialog on failure without exposing upstream details', async () => {
    vi.mocked(configureProviderPool).mockRejectedValue(new Error('private-token'))
    const user = userEvent.setup()
    const { saved, closed } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Personal', exact: true }))
    await user.click(screen.getByRole('button', { name: 'Save pool configuration' }))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(screen.queryByText('private-token')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Personal', exact: true })).toBeChecked()
    expect(saved).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
  })
})
