import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TokenStatsResponse, TokenTotals } from '@opencode-manager/shared/schemas'
import { fetchTokenStats } from '../../api/stats'
import { setLocale } from '../../i18n/locale'
import { Stats } from '../../pages/Stats'

vi.mock('../../api/stats', () => ({
  fetchTokenStats: vi.fn(),
}))
vi.mock('../notifications/PendingActionsGroup', () => ({ PendingActionsGroup: () => null }))

const totals: TokenTotals = {
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 150,
  cost: 0,
  estimatedCost: 0,
  unpricedMessages: 0,
  messages: 3,
  sessions: 1,
}
const data: TokenStatsResponse = {
  generatedAt: new Date(2026, 9, 8).getTime(),
  from: new Date(2026, 9, 1).getTime(),
  to: new Date(2026, 9, 8).getTime(),
  interval: 'day',
  totals,
  previous: totals,
  series: [],
  buckets: [],
  breakdown: [],
  facets: { model: [], provider: [], account: [], project: [], agent: [], category: [], session: [] },
  attribution: { accountTokens: 0, trackedSince: null },
  index: { messages: 3, firstMessageAt: null },
}
let client: QueryClient

beforeEach(() => {
  setLocale('ko')
  vi.stubGlobal('innerWidth', 1280)
  localStorage.clear()
  vi.mocked(fetchTokenStats).mockResolvedValue(data)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  setLocale('en')
})

it('renders Korean ranges, date subtitle, KPI labels and keeps the selected range', async () => {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Stats />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByText('10월 1일 ~ 10월 7일')).toBeVisible()
  expect(screen.getByRole('heading', { name: '토큰 사용량' })).toBeVisible()
  expect(screen.getByRole('radio', { name: '1일' })).toBeVisible()
  expect(screen.getByRole('radio', { name: '토큰' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('tab', { name: /^개요/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('article', { name: '캐시 히트율' })).toBeVisible()
  expect(screen.getByText('입력 100 · 출력 50')).toBeVisible()
  expect(screen.getByRole('switch', { name: '자동 새로고침' })).toBeVisible()
  fireEvent.click(screen.getByRole('radio', { name: '7일' }))
  expect(screen.getByRole('radio', { name: '7일' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByText(/Oct 1 to Oct 7/)).not.toBeInTheDocument()
})
