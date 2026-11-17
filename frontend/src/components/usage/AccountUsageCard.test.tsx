import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AccountUsageSchema, type AccountUsage } from '@opencode-manager/shared/schemas'
import { AccountUsageCard } from './AccountUsageCard'

function account(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    provider: 'openai',
    accountKey: 'primary',
    label: 'Primary',
    email: 'reeltalk.dev@gmail.com',
    planType: 'pro',
    enabled: true,
    state: 'ok',
    confidence: 'fresh',
    windows: [
      { key: 'five_hour', label: '5 hours', usedPercent: 5 },
      { key: 'weekly', label: 'Weekly', usedPercent: 20 },
    ],
    ...overrides,
  }
}

describe('AccountUsageCard quota windows', () => {
  afterEach(() => vi.useRealTimers())

  it('shows a stale account as last known usage with its last reported reset', () => {
    render(
      <AccountUsageCard
        account={account({
          confidence: 'stale',
          windows: [{ key: 'five_hour', label: '5 hours', usedPercent: 40, resetAt: Date.UTC(2026, 9, 14, 10) }],
          planType: undefined,
        })}
      />,
    )

    expect(screen.getByText('Stale')).toBeInTheDocument()
    expect(screen.getByText('Last known usage')).toBeInTheDocument()
    expect(screen.getByText(/^Last reported reset:/)).toBeInTheDocument()
  })

  it('shows when a rate limited account resumes', () => {
    render(
      <AccountUsageCard account={account({ state: 'rate-limited', rateLimitedUntil: Date.UTC(2026, 9, 14, 10) })} />,
    )

    expect(screen.getByText('Rate limited')).toBeInTheDocument()
    expect(screen.getByText(/^Paused until /)).toBeInTheDocument()
  })

  it('explains an account that has not served a request yet', () => {
    render(<AccountUsageCard account={account({ state: 'awaiting-first-request', confidence: 'unknown', windows: [] })} />)

    expect(screen.getByText('No data yet — updates after the next request')).toBeInTheDocument()
    expect(screen.getByText('Current usage is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('preserves the existing weekly quota when Pro has no primary window', () => {
    render(<AccountUsageCard account={account({ windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 20 }] })} />)

    expect(screen.getByText('Weekly')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
  })

  it.each([
    { planType: 'prolite', resetInMs: 3600000 },
    { planType: 'plus', resetInMs: 6 * 86400000 },
  ])('shows a weekly primary quota as 7 days for %j', ({ planType, resetInMs }) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 10, 12))
    render(
      <AccountUsageCard
        account={account({
          planType,
          windows: [
            {
              key: 'five_hour',
              label: '5 hours',
              usedPercent: 67,
              resetAt: Date.now() + resetInMs,
              updatedAt: Date.now(),
            },
            { key: 'weekly', label: 'Weekly', usedPercent: 0, updatedAt: Date.now() },
          ],
        })}
      />,
    )

    expect(screen.queryByText('5 hours')).not.toBeInTheDocument()
    expect(screen.getByText('7 days')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['67'])
  })

  it('renders an active Anthropic account with a separate exhausted Fable quota', () => {
    const usage = AccountUsageSchema.parse(
      account({
        provider: 'anthropic',
        windows: [
          { key: 'five_hour', label: '5 hours', usedPercent: 0 },
          { key: 'seven_day', label: '7 days', usedPercent: 54 },
          { key: 'seven_day_fable', label: 'Fable only · 7 days', usedPercent: 100 },
        ],
      }),
    )

    render(<AccountUsageCard account={usage} />)

    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByText('Rate limited')).not.toBeInTheDocument()
    expect(screen.getByText('Fable only · 7 days')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow'))).toEqual([
      '0',
      '54',
      '100',
    ])
  })

  it.each([{ planType: 'plus' }, { provider: 'anthropic' as const }])(
    'retains both windows for accounts outside the explicit exception: %j',
    (overrides) => {
      render(<AccountUsageCard account={account(overrides)} />)

      expect(screen.getByText('5 hours')).toBeInTheDocument()
      expect(screen.getByText('Weekly')).toBeInTheDocument()
    },
  )
})
