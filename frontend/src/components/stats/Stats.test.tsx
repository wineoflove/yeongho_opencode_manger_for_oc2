import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TokenStatsBucket, TokenStatsResponse, TokenTotals } from '@opencode-manager/shared/schemas'
import { fetchTokenStats } from '../../api/stats'
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
  cost: 4025,
  estimatedCost: 11254,
  unpricedMessages: 0,
  messages: 3,
  sessions: 1,
}

function bucket(start: number, usage: TokenTotals): TokenStatsBucket {
  return {
    start,
    values: [usage.total],
    total: usage.total,
    cost: usage.cost,
    estimatedCost: usage.estimatedCost,
    unpricedMessages: usage.unpricedMessages,
    messages: usage.messages,
    sessions: usage.sessions,
    accountTokens: usage.total,
    tokens: {
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      reasoning: usage.reasoning,
    },
    providers: { anthropic: usage.total * 0.8, openai: usage.total * 0.2 },
  }
}

function response(overrides: Partial<TokenTotals> = {}): TokenStatsResponse {
  const usage = { ...totals, ...overrides }
  return {
    generatedAt: 3000,
    from: 2000,
    to: 3000,
    interval: 'day',
    totals: usage,
    previous: { ...totals, total: 100 },
    series: [{ key: 'input', label: 'Input' }],
    buckets: [bucket(2000, usage)],
    breakdown: [{ key: 'mixed', label: 'Mixed model', totals: usage, share: 1 }],
    facets: {
      model: [],
      provider: [
        { key: 'anthropic', label: 'Anthropic', total: 120 },
        { key: 'openai', label: 'OpenAI', total: 30 },
      ],
      account: [],
      project: [],
      agent: [],
      category: [],
      session: [],
    },
    attribution: { accountTokens: 120, trackedSince: null },
    index: { messages: 3, firstMessageAt: 1000 },
  }
}

const clients: QueryClient[] = []

function renderStats(data = response(), width = 1280, path = '/stats') {
  vi.stubGlobal('innerWidth', width)
  vi.mocked(fetchTokenStats).mockResolvedValue(data)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Stats />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function card(name: string) {
  return screen.getByRole('article', { name })
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
  vi.stubGlobal('PointerEvent', MouseEvent)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Statistics overview', () => {
  it('uses filtered provider buckets rather than self-filter-excluded facets', async () => {
    const data = response()
    data.buckets = data.buckets.map((item) => ({ ...item, providers: { openai: item.total } }))
    renderStats(data, 1280, '/stats?filter=provider:openai')
    expect(within(await screen.findByRole('article', { name: 'OPENAI share' })).getByText('100.0%')).toBeVisible()
    expect(screen.queryByRole('article', { name: 'ANTHROPIC share' })).not.toBeInTheDocument()
  })

  it('shows updating rather than epoch age while a new range has placeholder data', async () => {
    renderStats()
    await screen.findAllByTestId('kpi-card')
    vi.mocked(fetchTokenStats).mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('radio', { name: '7d' }))
    expect(await screen.findByLabelText('Updating statistics')).toBeVisible()
    expect(screen.queryByLabelText(/^Last synced/)).not.toBeInTheDocument()
  })

  it('shows status chips, the overview badge and KPI cards with sparklines', async () => {
    renderStats()
    await screen.findAllByTestId('kpi-card')
    expect(screen.getByRole('heading', { name: 'Token usage' })).toBeVisible()
    expect(screen.getByLabelText(/^Last synced/)).toHaveTextContent(/Synced\d+s/)
    expect(screen.queryByText('Coverage')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Overview\s*150$/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(card('Tokens')).getByText('150')).toBeVisible()
    expect(within(card('Tokens')).getByText('+50.0%')).toBeVisible()
    expect(within(card('Tokens')).getByText('Input 100 · Output 50')).toBeVisible()
    expect(within(card('Cost*')).getByText('$15,279.00')).toBeVisible()
    expect(within(card('Cost*')).getByText('Recorded $4.0K · estimated $11.3K')).toHaveAttribute(
      'title',
      'recorded $4,025.00 + estimated $11,254.00',
    )
    expect(within(card('Responses')).getByText('50 tokens per response')).toBeVisible()
    expect(within(card('ANTHROPIC share')).getByText('80.0%')).toBeVisible()
    expect(within(card('OPENAI share')).getByText('30 of 150')).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Account coverage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /^Account/ })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('kpi-sparkline')).toHaveLength(7)
    expect(screen.getByText(/models.dev estimates/)).toHaveTextContent('Not a subscription bill.')
  })

  it('shows combined bucket cost and a readable split after tapping the chart', async () => {
    renderStats()
    const chart = await screen.findByRole('img', { name: /Token usage per day/ })
    fireEvent.pointerDown(chart, { clientX: 100, clientY: 40 })
    const tooltip = screen.getByRole('status')
    expect(within(tooltip).getByText('$15,279.00')).toHaveTextContent('API-equivalent cost $15,279.00')
    expect(within(tooltip).getByText('recorded $4,025.00 + estimated $11,254.00')).toBeVisible()
  })

  it('switches the chart to cost and to totals, and remembers the auto refresh preference', async () => {
    renderStats()
    await screen.findAllByTestId('kpi-card')
    fireEvent.click(screen.getByRole('radio', { name: 'Show totals' }))
    expect(screen.getByRole('radio', { name: 'Show totals' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radiogroup', { name: 'Split chart by' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Cost' }))
    expect(screen.getByRole('heading', { name: /Cost per day/ })).toBeVisible()
    expect(screen.queryByRole('radiogroup', { name: 'Chart style' })).not.toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Auto refresh' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem('oc:stats:auto-refresh')).toBe('false')
  })

  it.each([0, 12])('keeps recorded-only cost %s without a split and reports missing prices', async (cost) => {
    renderStats(response({ cost, estimatedCost: 0, unpricedMessages: 1234 }))
    expect(within(await screen.findByRole('article', { name: 'Cost*' })).getByText(`$${cost.toFixed(2)}`)).toBeVisible()
    expect(screen.getByText(/Unpriced responses: 1,234/)).toHaveTextContent('they contribute $0')
    expect(screen.queryByText(/recorded \$/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }))
    expect(within(await screen.findByRole('table')).getByText(`$${cost.toFixed(2)}`)).not.toHaveAttribute('title')
  })
})

describe('Statistics dimension tabs', () => {
  it('shows the cost split in the desktop table for the selected dimension', async () => {
    renderStats(response(), 1280, '/stats?tab=model')
    const table = await screen.findByRole('table')
    expect(within(table).getByTitle('recorded $4,025.00 + estimated $11,254.00')).toHaveTextContent('$15,279.00')
    expect(screen.getByRole('tab', { name: 'Model' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tablist', { name: 'Group by' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('kpi-card')).not.toBeInTheDocument()
  })

  it('shows a visible split in mobile rows and keeps row filtering working', async () => {
    renderStats(response({ cost: 0, estimatedCost: 10904 }), 390, '/stats?tab=model')
    const row = await screen.findByRole('button', { name: /Mixed model/ })
    expect(row).toHaveTextContent('100.0% · $10,904.00')
    expect(within(row).getByText('recorded $0.00 + estimated $10,904.00')).toBeVisible()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(await screen.findByRole('button', { name: 'Remove Model filter mixed' })).toBeVisible()
  })
})
