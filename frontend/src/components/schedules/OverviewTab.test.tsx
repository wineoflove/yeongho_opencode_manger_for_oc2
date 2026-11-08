import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@/i18n/locale'
import { OverviewTab } from './OverviewTab'
import { overviewFixture } from '@/test/scheduleOverviewFixture'

const mocks = vi.hoisted(() => ({ overview: vi.fn(), navigate: vi.fn(), refetch: vi.fn() }))
vi.mock('@/hooks/useScheduleOverview', () => ({ useScheduleOverview: mocks.overview }))
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}))

function mount() {
  return render(
    <MemoryRouter initialEntries={['/schedules']}>
      <OverviewTab />
    </MemoryRouter>,
  )
}

describe('OverviewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(1791972000000)
    mocks.overview.mockReturnValue({
      data: overviewFixture(),
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: mocks.refetch,
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    setLocale('en')
  })

  it('renders all sections, six metrics, chart buckets, warnings and untracked history', () => {
    mount()
    const cards = screen.getAllByTestId('overview-kpi')
    expect(cards).toHaveLength(6)
    expect(within(cards[0]).getByText('1')).toBeInTheDocument()
    expect(within(cards[1]).getByText('12 items')).toBeInTheDocument()
    expect(within(cards[2]).getByText('66.7%')).toBeInTheDocument()
    expect(within(cards[3]).getByText('2')).toBeInTheDocument()
    expect(within(cards[4]).getByText('5m 05s')).toBeInTheDocument()
    expect(within(cards[5]).getByText('$0.42')).toBeInTheDocument()
    expect(screen.getAllByTestId('throughput-bucket')).toHaveLength(7)
    expect(screen.getAllByTestId('recent-run')).toHaveLength(1)
    expect(screen.getByText('Agent unavailable')).toBeInTheDocument()
    expect(screen.getByText('New automation')).toBeInTheDocument()
    expect(screen.getAllByText('Not tracked').length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: 'Subscription usage' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open session' })).toHaveAttribute('href', '/repos/3/sessions/session-42')
  })

  it.each([
    ['en', 'Sisyphus', 'Agent mismatch (Sisyphus)'],
    ['ko', 'Sisyphus', '에이전트 불일치 (Sisyphus)'],
    ['en', null, 'Agent mismatch'],
    ['ko', null, '에이전트 불일치'],
  ] as const)('renders %s mismatch warnings for agentUsed %s', (locale, agentUsed, expected) => {
    setLocale(locale)
    const data = overviewFixture()
    data.jobs = data.jobs.map((job) => ({ ...job, agentStatus: 'mismatch', agentUsed }))
    mocks.overview.mockReturnValue({ data, refetch: mocks.refetch })

    mount()

    expect(screen.getAllByText(expected)).toHaveLength(2)
  })

  it('switches ranges and refreshes on demand', () => {
    mount()
    expect(mocks.overview).toHaveBeenLastCalledWith(7)
    fireEvent.click(screen.getByRole('radio', { name: '24h' }))
    expect(mocks.overview).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('radio', { name: '30d' }))
    expect(mocks.overview).toHaveBeenLastCalledWith(30)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
  })

  it('advances elapsed time and marks overdue and near-deadline runs', () => {
    const data = overviewFixture()
    data.running[0].typicalDurationMs = 185000
    mocks.overview.mockReturnValue({ data, refetch: mocks.refetch })
    const view = mount()
    expect(screen.getByText('03:05')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('03:06')).toHaveClass('text-orange-600')
    expect(screen.getByText('Running longer than usual')).toBeInTheDocument()
    data.running[0].deadlineAt = Date.now() + 9 * 60000
    view.rerender(
      <MemoryRouter>
        <OverviewTab />
      </MemoryRouter>,
    )
    expect(screen.getByText('Deadline in 9m')).toHaveClass('text-red-600')
  })

  it('links jobs and running records to repository detail with returnTo', () => {
    mount()
    expect(screen.getByRole('link', { name: /Daily review/ })).toHaveAttribute(
      'href',
      '/repos/3/schedules?jobId=7&scheduleTab=detail&returnTo=%2Fschedules',
    )
    fireEvent.click(screen.getByRole('button', { name: /Daily review/ }))
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/repos/3/schedules?jobId=7&scheduleTab=runs&runId=42&returnTo=%2Fschedules',
    )
  })

  it('offers a retry when overview fails', () => {
    mocks.overview.mockReturnValue({ error: new Error('offline'), refetch: mocks.refetch })
    mount()
    expect(screen.getByRole('alert')).toHaveTextContent('offline')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a timer without running work', () => {
    mocks.overview.mockReturnValue({ data: { ...overviewFixture(), running: [] }, refetch: mocks.refetch })
    mount()
    expect(screen.getByText('Nothing running.')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders Korean overview labels and unknown metrics', () => {
    setLocale('ko')
    mount()
    expect(screen.getByRole('heading', { name: '개요' })).toBeInTheDocument()
    expect(screen.getByText('성공률 (7일)')).toBeInTheDocument()
    expect(screen.getAllByText('평균 소요').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: '지금 실행 중' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '다음 예정' })).toBeInTheDocument()
    expect(screen.getAllByText('추적 안 됨').length).toBeGreaterThan(0)
  })
})
