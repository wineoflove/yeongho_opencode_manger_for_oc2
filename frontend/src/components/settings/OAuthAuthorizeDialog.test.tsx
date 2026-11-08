import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { oauthApi } from '@/api/oauth'
import type { IntegrationMethod, OAuthAuthorizeResponse } from '@/api/oauth'
import { OAuthAuthorizeDialog } from './OAuthAuthorizeDialog'

vi.mock('@/api/oauth', () => ({
  oauthApi: {
    authorize: vi.fn(),
  },
}))

const openAIMethods: IntegrationMethod[] = [
  { id: 'fixture-chatgpt-device', type: 'oauth', label: 'ChatGPT Pro/Plus (headless)' },
  { type: 'key', label: 'Manually enter API Key' },
]

const authorizeResponse: OAuthAuthorizeResponse = {
  attemptID: 'fixture-attempt',
  url: 'https://auth.example.test/device',
  instructions: 'Enter code: FIXT-0001',
  mode: 'auto',
}

function renderDialog(hasAccounts: boolean) {
  const onSuccess = vi.fn()
  render(
    <OAuthAuthorizeDialog
      providerId="openai"
      providerName="OpenAI"
      methods={openAIMethods}
      hasAccounts={hasAccounts}
      open
      onOpenChange={vi.fn()}
      onSuccess={onSuccess}
    />,
  )
  return { onSuccess }
}

describe('OAuthAuthorizeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(oauthApi.authorize).mockResolvedValue(authorizeResponse)
  })

  it('starts the only OAuth method of a first connection with its server-provided method ID', async () => {
    const { onSuccess } = renderDialog(false)

    expect(screen.getByRole('dialog', { name: 'Connect to OpenAI' })).toBeInTheDocument()
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(authorizeResponse, 'fixture-chatgpt-device')
    })
    expect(oauthApi.authorize).toHaveBeenCalledExactlyOnceWith('openai', 'fixture-chatgpt-device', undefined)
  })

  it('explains that another account is added and selected, then waits for the method choice', async () => {
    const user = userEvent.setup()
    const { onSuccess } = renderDialog(true)

    const dialog = screen.getByRole('dialog', { name: 'Add OpenAI account' })
    expect(
      within(dialog).getByText(
        'Select an authentication method for the new account. Existing accounts are kept, and the new account becomes the selected account.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Manually enter API Key' })).not.toBeInTheDocument()
    expect(oauthApi.authorize).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'ChatGPT Pro/Plus (headless)' }))

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(authorizeResponse, 'fixture-chatgpt-device')
    })
    expect(oauthApi.authorize).toHaveBeenCalledExactlyOnceWith('openai', 'fixture-chatgpt-device', undefined)
  })
})
