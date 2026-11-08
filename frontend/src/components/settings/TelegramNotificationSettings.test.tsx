import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TelegramNotificationSettings } from './TelegramNotificationSettings'

const empty = { enabled: false, hasBotToken: false, chatId: '', publicUrl: '', source: 'none' }
const saved = { enabled: true, hasBotToken: true, chatId: '12345', publicUrl: 'https://ocm.example.com', source: 'db' }
const fetchMock = vi.fn<typeof fetch>()
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function open(data = saved) {
  fetchMock.mockResolvedValueOnce(respond(data))
  render(<TelegramNotificationSettings />)
  await screen.findByLabelText('Bot token')
  return userEvent.setup()
}

describe('Telegram settings API form', () => {
  it('loads redacted metadata and never prefills the saved password', async () => {
    await open()
    expect(fetchMock.mock.calls[0][0]).toContain('/api/notifications/telegram')
    expect(screen.getByLabelText('Bot token')).toHaveValue('')
    expect(screen.getByLabelText('Bot token')).toHaveAttribute('type', 'password')
    expect(screen.getByText(/Token saved/)).toBeInTheDocument()
  })

  it('omits an empty saved token and tests only after saving edits', async () => {
    const user = await open()
    await user.clear(screen.getByLabelText('Chat ID'))
    await user.type(screen.getByLabelText('Chat ID'), '98765')
    expect(screen.getByRole('button', { name: 'Send Telegram test' })).toBeDisabled()
    fetchMock.mockResolvedValueOnce(respond({ ...saved, chatId: '98765' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Changes apply immediately/)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      enabled: true,
      chatId: '98765',
      publicUrl: saved.publicUrl,
    })
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT')
    fetchMock.mockResolvedValueOnce(respond({ ok: true, status: 'sent' }))
    await user.click(screen.getByRole('button', { name: 'Send Telegram test' }))
    await screen.findByText(/Telegram accepted/)
    expect(fetchMock.mock.calls[2][0]).toContain('/api/notifications/telegram/test')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST')
  })

  it('requires credentials to enable, allows disabled blanks and clears a new token after save', async () => {
    const user = await open(empty)
    expect(screen.getByRole('button', { name: 'Send Telegram test' })).toBeDisabled()
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter a bot token/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('switch'))
    fetchMock.mockResolvedValueOnce(respond({ ...empty, source: 'db' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Changes apply immediately/)
    await user.type(screen.getByLabelText('Bot token'), '123456:synthetic-test-token-only')
    fetchMock.mockResolvedValueOnce(respond({ ...empty, hasBotToken: true, source: 'db' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByLabelText('Bot token')).toHaveValue(''))
  })

  it('preserves edits on server validation failure', async () => {
    const user = await open()
    await user.type(screen.getByLabelText('Bot token'), 'invalid-test-token')
    fetchMock.mockResolvedValueOnce(respond({ error: 'Invalid Telegram settings' }, 400))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save/)
    expect(screen.getByLabelText('Bot token')).toHaveValue('invalid-test-token')
  })

  it.each(['failed', 'not_configured'])('does not claim success for HTTP 200 %s', async (status) => {
    const user = await open()
    fetchMock.mockResolvedValueOnce(respond({ ok: false, status }))
    await user.click(screen.getByRole('button', { name: 'Send Telegram test' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(status === 'failed' ? /test failed/ : /not configured/)
    expect(screen.queryByText(/Telegram accepted/)).not.toBeInTheDocument()
  })

  it('shows loading and load failure with a working retry', async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: 'Unavailable' }, 500))
    render(<TelegramNotificationSettings />)
    expect(screen.getByRole('status')).toHaveTextContent(/Loading/)
    await screen.findByRole('alert')
    fetchMock.mockResolvedValueOnce(respond(empty))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByLabelText('Bot token')
  })

  it('prevents duplicate tests while pending and handles network failure', async () => {
    const user = await open()
    let rejectRequest: (reason: Error) => void = () => {}
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject
        }),
    )
    await user.click(screen.getByRole('button', { name: 'Send Telegram test' }))
    expect(screen.getByRole('button', { name: 'Testing...' })).toBeDisabled()
    expect(screen.getByLabelText('Chat ID')).toBeDisabled()
    rejectRequest(new Error('offline'))
    await screen.findByRole('alert')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
