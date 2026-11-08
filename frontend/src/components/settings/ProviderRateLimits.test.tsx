import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProviderRateLimits } from '@/api/provider-rate-limits'
import { ProviderRateLimits } from './ProviderRateLimits'

vi.mock('@/api/provider-rate-limits', () => ({
  getProviderRateLimits: vi.fn(),
}))
vi.mock('@/i18n/translate', () => ({
  msg: (key: string) => key,
  t: (key: string, vars?: Record<string, string | number>) =>
    key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? '')),
}))

describe('provider HTTP limit observations', () => {
  beforeEach(() => vi.resetAllMocks())
  it.each(['empty', 'error', 'partial'] as const)('queries only when expanded and distinguishes %s', async (state) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const user = userEvent.setup()
    if (state === 'error') vi.mocked(getProviderRateLimits).mockRejectedValue(new Error('private-error'))
    else
      vi.mocked(getProviderRateLimits).mockResolvedValue({
        persistence: 'memory',
        observations:
          state === 'empty'
            ? []
            : [
                {
                  providerId: 'provider',
                  modelId: 'fixture-model',
                  source: 'anthropic-http-headers',
                  accountId: null,
                  observedAt: 1,
                  stale: true,
                  status: 'partial',
                  retryAfterSeconds: null,
                  invalidHeaders: ['retry-after'],
                  buckets: [
                    {
                      resource: 'requests',
                      remaining: 0,
                      limit: null,
                      resetAt: null,
                      remainingRounded: false,
                    },
                  ],
                  subscriptionWindows: [],
                  subscriptionStatus: null,
                  representativeClaim: null,
                },
              ],
      })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <ProviderRateLimits providerId="provider" />
      </QueryClientProvider>,
    )
    try {
      expect(getProviderRateLimits).not.toHaveBeenCalled()
      await user.click(screen.getByText('API limit observations'))
      if (state === 'empty')
        expect(
          await screen.findByText(
            'No HTTP limit headers have been observed. Collection may be inactive or unavailable.',
          ),
        ).toBeInTheDocument()
      if (state === 'error')
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'This does not indicate an authentication or quota failure.',
        )
      if (state === 'partial') {
        expect(await screen.findByText('fixture-model')).toBeInTheDocument()
        expect(screen.getByText('Remaining 0 / limit Unknown')).toBeInTheDocument()
        expect(screen.getByText('Stale observation — current remaining capacity is unknown.')).toBeInTheDocument()
        expect(screen.getByText('Some limit headers could not be parsed.')).toBeInTheDocument()
      }
      expect(screen.queryByText('private-error')).not.toBeInTheDocument()
    } finally {
      unmount()
      client.clear()
    }
  })

  it('shows subscription usage windows reported by unified headers', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    vi.mocked(getProviderRateLimits).mockResolvedValue({
      persistence: 'memory',
      observations: [
        {
          providerId: 'anthropic',
          modelId: 'claude-fixture',
          source: 'anthropic-http-headers',
          accountId: null,
          observedAt: Date.now(),
          stale: false,
          status: 'observed',
          retryAfterSeconds: null,
          invalidHeaders: [],
          buckets: [],
          subscriptionWindows: [
            { window: 'five_hour', usedPercent: 42, resetAt: 1_800_000_000_000, status: 'allowed' },
            { window: 'seven_day', usedPercent: null, resetAt: null, status: 'novel_status' },
          ],
          subscriptionStatus: 'allowed_warning',
          representativeClaim: 'five_hour',
        },
      ],
    })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <ProviderRateLimits providerId="anthropic" />
      </QueryClientProvider>,
    )
    try {
      await user.click(screen.getByText('API limit observations'))
      const usage = await screen.findByTestId('subscription-usage')
      expect(usage).toHaveTextContent('Subscription usage · Warning')
      expect(usage).toHaveTextContent('5-hour window')
      expect(usage).toHaveTextContent('Used 42% · Allowed')
      expect(usage).toHaveTextContent('7-day window')
      expect(usage).toHaveTextContent('Unknown · novel_status')
      expect(usage).toHaveTextContent('Reset at')
    } finally {
      unmount()
      client.clear()
    }
  })

  it.each([
    ['rejected', 'Subscription usage · Rejected'],
    ['constructor', 'Subscription usage · constructor'],
  ])('shows a status-only subscription observation with status %s', async (status, expected) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    vi.mocked(getProviderRateLimits).mockResolvedValue({
      persistence: 'memory',
      observations: [
        {
          providerId: 'anthropic',
          modelId: 'claude-fixture',
          source: 'anthropic-http-headers',
          accountId: null,
          observedAt: Date.now(),
          stale: false,
          status: 'observed',
          retryAfterSeconds: null,
          invalidHeaders: [],
          buckets: [],
          subscriptionWindows: [],
          subscriptionStatus: status,
          representativeClaim: null,
        },
      ],
    })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <ProviderRateLimits providerId="anthropic" />
      </QueryClientProvider>,
    )
    try {
      await user.click(screen.getByText('API limit observations'))
      const usage = await screen.findByTestId('subscription-usage')
      expect(usage).toHaveTextContent(expected)
      expect(usage).not.toHaveTextContent('function')
      expect(usage).not.toHaveTextContent('Used')
    } finally {
      unmount()
      client.clear()
    }
  })
})

