import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SessionMessageInfo } from '@opencode-manager/shared/opencode'
import recorded from '@/test/opencode2TodoMessages.json'
import { sessionTranscriptQueryKey } from '@/lib/queryInvalidation'
import { serverScopedKey } from '@/lib/serverScope'
import type { TranscriptCache } from '@/lib/session-projection'
import { useSessionTodoProgress, type SessionTodoTarget } from './useSessionTodoProgress'

const mocks = vi.hoisted(() => ({ listSessionMessages: vi.fn() }))

vi.mock('@/api/opencode', () => ({ listSessionMessages: mocks.listSessionMessages }))

const todoMessages = recorded as unknown as SessionMessageInfo[]
const plainMessages: SessionMessageInfo[] = [{ id: 'msg_user', type: 'user', text: 'hi', time: { created: 1 } }]

function setup(targets: SessionTodoTarget[], enabled = true, prime?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  prime?.(client)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useSessionTodoProgress(targets, enabled), { wrapper })
}

describe('useSessionTodoProgress', () => {
  beforeEach(() => {
    mocks.listSessionMessages.mockReset()
  })

  it('reads the newest message page of a session whose transcript is not cached', async () => {
    mocks.listSessionMessages.mockResolvedValue({ messages: todoMessages })
    const targets = [{ key: 'a', sessionID: 'ses_a', serverId: 'srv_remote' }]

    const { result } = setup(targets)

    await waitFor(() => expect(result.current.get('a')).toEqual({ completed: 2, total: 3, percent: 67 }))
    expect(mocks.listSessionMessages).toHaveBeenCalledWith('ses_a', { limit: 100 }, 'srv_remote')
  })

  it('uses a cached transcript without reading the session again', async () => {
    const targets = [{ key: 'b', sessionID: 'ses_b' }]
    const { result } = setup(targets, true, (client) =>
      client.setQueryData<TranscriptCache>(serverScopedKey(sessionTranscriptQueryKey('ses_b')), {
        transcript: { messages: todoMessages, pending: [], status: 'idle' },
      }),
    )

    await waitFor(() => expect(result.current.get('b')?.completed).toBe(2))
    expect(mocks.listSessionMessages).not.toHaveBeenCalled()
  })

  it('leaves sessions without todos out and reads nothing while disabled', async () => {
    mocks.listSessionMessages.mockResolvedValue({ messages: plainMessages })
    const enabled = setup([{ key: 'c', sessionID: 'ses_c' }])
    await waitFor(() => expect(mocks.listSessionMessages).toHaveBeenCalledOnce())
    expect(enabled.result.current.size).toBe(0)

    mocks.listSessionMessages.mockClear()
    const disabled = setup([{ key: 'd', sessionID: 'ses_d' }], false)
    expect(disabled.result.current.size).toBe(0)
    expect(mocks.listSessionMessages).not.toHaveBeenCalled()
  })
})
