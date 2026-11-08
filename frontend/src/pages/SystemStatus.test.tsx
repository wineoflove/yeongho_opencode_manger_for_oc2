import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemStatus } from './SystemStatus'
import { fetchSystemStatus } from '@/api/system'
import { systemStatusFixture } from '@/test/systemStatusFixture'

vi.mock('@/api/system', () => ({ fetchSystemStatus: vi.fn() }))
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => true }))
vi.mock('@/contexts/EventContext', () => ({
  usePermissions: () => ({ pendingCount: 0 }),
  useQuestions: () => ({ pendingCount: 0 }),
}))

describe('SystemStatus', () => {
  beforeEach(() => vi.mocked(fetchSystemStatus).mockReset().mockResolvedValue(systemStatusFixture))

  it('shows detailed status and the global mobile navigation', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/system']}>
          <SystemStatus />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('12.59 / 18 cores')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'System status' })).toBeInTheDocument()
    expect(screen.getByText('Read-only. OCM does not stop or restart processes.')).toBeInTheDocument()
    expect(screen.getByText(/Collected .* · darwin/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(fetchSystemStatus).toHaveBeenCalledTimes(2)
  })
})
