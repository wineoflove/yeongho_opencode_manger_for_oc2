import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatDateTime } from '../../i18n/format'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fetchWorkflowSession } from '../../api/stats'
import { FetchError } from '../../api/fetchWrapper'
import { workflowTimelineFixture } from '../../test/workflowFixture'
import { WorkflowSessionTimeline } from './WorkflowSessionTimeline'

vi.mock('@/api/stats', () => ({ fetchWorkflowSession: vi.fn() }))
const clients: QueryClient[] = []
function mount(initialSessionId = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <WorkflowSessionTimeline initialSessionId={initialSessionId} />
    </QueryClientProvider>,
  )
}
beforeEach(() => {
  vi.mocked(fetchWorkflowSession).mockResolvedValue(workflowTimelineFixture)
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.resetAllMocks()
})

describe('Workflow session timeline', () => {
  it('renders one context bar per step with distinct error, guard and compaction markers', async () => {
    mount('ses_example123')
    expect(await screen.findAllByTestId('context-bar')).toHaveLength(3)
    expect(screen.getAllByTestId('tool-error-marker')).toHaveLength(1)
    expect(screen.getAllByTestId('guard-marker')).toHaveLength(1)
    expect(screen.getAllByTestId('compaction-marker')).toHaveLength(1)
    expect(screen.getByRole('term')).toHaveTextContent('Compaction')
    expect(screen.getByRole('definition')).toHaveTextContent(formatDateTime(1700000120000))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('rejects an invalid ID without a network request', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '../invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid session ID starting with ses_.')
    expect(fetchWorkflowSession).not.toHaveBeenCalled()
  })

  it('shows session not found after opening a missing valid ID', async () => {
    vi.mocked(fetchWorkflowSession).mockRejectedValue(new FetchError('WORKFLOW_SESSION_NOT_FOUND', 404))
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ses_missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Session not found')
    expect(fetchWorkflowSession).toHaveBeenCalledWith('ses_missing')
  })
})
