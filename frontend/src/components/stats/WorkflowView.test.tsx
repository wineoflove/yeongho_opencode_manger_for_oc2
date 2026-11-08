import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FetchError } from '../../api/fetchWrapper'
import { fetchLearningLint, fetchWorkflowSession, fetchWorkflowStats } from '../../api/stats'
import { setLocale } from '../../i18n/locale'
import { workflowFixture, workflowTimelineFixture } from '../../test/workflowFixture'
import { WorkflowView } from './WorkflowView'

vi.mock('@/api/stats', () => ({
  fetchLearningLint: vi.fn(),
  fetchWorkflowSession: vi.fn(),
  fetchWorkflowStats: vi.fn(),
}))
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <WorkflowView range="7d" />
    </QueryClientProvider>,
  )
}
beforeEach(() => {
  vi.mocked(fetchWorkflowStats).mockResolvedValue(workflowFixture)
  vi.mocked(fetchWorkflowSession).mockResolvedValue(workflowTimelineFixture)
  vi.mocked(fetchLearningLint).mockResolvedValue({
    scanned: 8,
    counts: { verified: 5, pending: 2, superseded: 1, other: 0 },
    violations: [],
  })
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.resetAllMocks()
})

describe('Workflow view', () => {
  it('shows current and previous metrics with relative changes and lesson lookup outcomes', async () => {
    mount()
    const metric = await screen.findByRole('region', { name: 'Tool error rate' })
    expect(within(metric).getByText('10.0%')).toBeVisible()
    expect(within(metric).getByText('Previous: 20.0%')).toBeVisible()
    expect(within(metric).getByText('−50.0%')).toBeVisible()
    expect(screen.getByText('No lesson')).toBeVisible()
    expect(screen.getByText('Lookup failed')).toBeVisible()
    expect(screen.getByText('lesson-123')).toBeVisible()
    expect(screen.getByText('connected')).toBeVisible()
    expect(fetchWorkflowStats).toHaveBeenCalledWith('7d')
  })

  it('opens a repeated-call session timeline from its session ID', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'ses_example123' }))
    expect(await screen.findByRole('img', { name: 'Context tokens by step' })).toBeVisible()
    expect(fetchWorkflowSession).toHaveBeenCalledWith('ses_example123')
  })

  it('shows compatibility guidance instead of workflow numbers for the 503 code', async () => {
    vi.mocked(fetchWorkflowStats).mockRejectedValue(new FetchError('WORKFLOW_SOURCE_INCOMPATIBLE', 503))
    mount()
    expect(await screen.findByText('Workflow data is not compatible with this OpenCode version.')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Tool error rate' })).not.toBeInTheDocument()
    expect(screen.queryByText('Lesson store')).not.toBeInTheDocument()
  })

  it('reopens the same repeated-call session after manually opening another session', async () => {
    vi.mocked(fetchWorkflowSession).mockImplementation(async (id) => {
      if (id === 'ses_missing') throw new FetchError('WORKFLOW_SESSION_NOT_FOUND', 404)
      return workflowTimelineFixture
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'ses_example123' }))
    await screen.findByRole('img', { name: 'Context tokens by step' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ses_missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await screen.findByText('Session not found')
    fireEvent.click(screen.getByRole('button', { name: 'ses_example123' }))
    expect(await screen.findByRole('img', { name: 'Context tokens by step' })).toBeVisible()
    expect(screen.getByRole('textbox')).toHaveValue('ses_example123')
    expect(screen.queryByText('Session not found')).not.toBeInTheDocument()
  })

  it('translates metrics, missing lessons and MCP status into Korean', async () => {
    setLocale('ko')
    mount()
    expect(await screen.findByText('도구 오류율')).toBeVisible()
    expect(screen.getByText('교훈 없음')).toBeVisible()
    expect(screen.getByText('연결됨')).toBeVisible()
  })

  it('limits the lesson violations to twenty entries', async () => {
    vi.mocked(fetchLearningLint).mockResolvedValue({
      scanned: 30,
      counts: { verified: 5, pending: 24, superseded: 1, other: 0 },
      violations: Array.from({ length: 25 }, (_, index) => ({
        file: `file-${index}`,
        code: 'INVALID',
        detail: `detail-${index}`,
      })),
    })
    mount()
    expect(await screen.findByText('detail-19')).toBeVisible()
    expect(screen.queryByText('detail-20')).not.toBeInTheDocument()
  })

  it('keeps workflow data visible when lint fails', async () => {
    vi.mocked(fetchLearningLint).mockRejectedValue(new FetchError('LEARNING_LINT_FAILED', 500))
    mount()
    expect(await screen.findByText('Lint unavailable')).toBeVisible()
    expect(await screen.findByText('Tool error rate')).toBeVisible()
  })

  it('shows the empty range state and unknown MCP status without inventing data', async () => {
    vi.mocked(fetchWorkflowStats).mockResolvedValue({
      ...workflowFixture,
      totals: {
        ...workflowFixture.totals,
        current: {
          ...workflowFixture.totals.current,
          toolCalls: 0,
          userMessages: 0,
          inputContextTokens: 0,
          compactions: 0,
          guardBlocked: 0,
          guardAdjusted: 0,
        },
      },
      tools: [],
      mcp: workflowFixture.mcp.map((server) => ({ ...server, status: null })),
    })
    mount()
    expect((await screen.findAllByText('No workflow data in this range.')).length).toBeGreaterThan(0)
    expect(screen.getByText('Unknown')).toBeVisible()
  })
})
