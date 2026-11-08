import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionMessageInfo } from '@opencode-manager/shared/opencode'
import { SessionStatusSummary } from './SessionStatusSummary'
import { sessionElapsedMs } from '@/lib/sessionStatusSummary'

const mocks = vi.hoisted(() => ({
  useContextUsage: vi.fn(),
}))

vi.mock('@/hooks/useContextUsage', () => ({
  useContextUsage: mocks.useContextUsage,
}))

const NOW = 1_800_000_000_000

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'ses_1',
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW - 65_000, updated: NOW - 5_000 },
    location: { directory: '/repo' },
    ...overrides,
  } as SessionInfo
}

const messages = [
  { id: 'msg_u', type: 'user', time: { created: 1 }, text: 'Hi' },
  {
    id: 'msg_a',
    type: 'assistant',
    agent: 'build',
    model: { id: 'gpt-6', providerID: 'openai', variant: 'high' },
    content: [],
    time: { created: 2 },
  },
] as unknown as SessionMessageInfo[]

describe('SessionStatusSummary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mocks.useContextUsage.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the idle status, recorded duration, agent, model variant and message count', () => {
    render(
      <SessionStatusSummary
        sessionId="ses_1"
        session={session({
          time: {
            created: NOW - 65_000,
            updated: NOW - 5_000,
            idle: NOW - 5_000,
          },
        })}
        status="idle"
        active={false}
        messages={messages}
        hasOlder={false}
      />,
    )

    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.getByText('1m 00s')).toBeInTheDocument()
    expect(screen.getByText('build')).toBeInTheDocument()
    expect(screen.getByText('openai/gpt-6 · high')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('advances the duration every second while running and marks a partial message count', () => {
    render(
      <SessionStatusSummary sessionId="ses_1" session={session()} status="busy" active messages={messages} hasOlder />,
    )

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('1m 05s')).toBeInTheDocument()
    expect(screen.getByText('2+')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByText('1m 08s')).toBeInTheDocument()
  })

  it('labels a retrying session and renders cost and context usage', () => {
    mocks.useContextUsage.mockReturnValue({
      totalTokens: 50_000,
      contextLimit: 200_000,
      usagePercentage: 25,
    })
    render(
      <SessionStatusSummary
        sessionId="ses_1"
        session={session({ cost: 1.5 })}
        status="retry"
        active
        messages={messages}
        hasOlder={false}
      />,
    )

    expect(screen.getByText('Retrying')).toBeInTheDocument()
    expect(screen.getByText('$1.50')).toBeInTheDocument()
    expect(screen.getByText('50k / 200k · 25%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Context' })).toHaveAttribute('aria-valuenow', '25')
  })

  it('shows todo progress when the session has a todo list', () => {
    render(
      <SessionStatusSummary
        sessionId="ses_1"
        session={session()}
        status="idle"
        active={false}
        messages={messages}
        hasOlder={false}
        todos={[
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
          { content: 'c', status: 'pending' },
          { content: 'd', status: 'cancelled' },
        ]}
      />,
    )

    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('1/3 · 33%')).toBeInTheDocument()
  })

  it('stops the clock at the idle time and never reports a negative duration', () => {
    expect(sessionElapsedMs(session({ time: { created: 10, updated: 50, idle: 30 } }), false, 100)).toBe(20)
    expect(sessionElapsedMs(session({ time: { created: 10, updated: 50 } }), false, 100)).toBe(40)
    expect(sessionElapsedMs(session({ time: { created: 200, updated: 250 } }), true, 100)).toBe(0)
  })
})
