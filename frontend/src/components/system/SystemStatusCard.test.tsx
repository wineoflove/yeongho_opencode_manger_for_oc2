import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { SystemStatusCard } from './SystemStatusCard'
import { systemStatusFixture as data } from '@/test/systemStatusFixture'
import { setLocale } from '@/i18n/locale'

describe('SystemStatusCard', () => {
  it('renders reference metrics and accessible meters', () => {
    render(
      <MemoryRouter>
        <SystemStatusCard data={data} compact />
      </MemoryRouter>,
    )
    for (const text of ['12.59 / 18 cores', '70%', '63% free', '18 · 736.6 MB'])
      expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '70')
    expect(screen.getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuenow', '37')
    expect(within(screen.getByTestId('browser-chrome')).getByText('5')).toBeInTheDocument()
    expect(within(screen.getByTestId('browser-headless')).getByText('13')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Details →' })).toHaveAttribute('href', '/system')
  })

  it('translates Korean labels and number templates', () => {
    setLocale('ko')
    render(
      <MemoryRouter>
        <SystemStatusCard data={data} compact />
      </MemoryRouter>,
    )
    for (const text of ['시스템', '30초 주기', '메모리', '63% 여유', '12.59 / 18코어'])
      expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('shows unsupported and missing values without invented measurements', () => {
    render(
      <SystemStatusCard
        data={{
          ...data,
          overall: 'unknown',
          errors: ['UNSUPPORTED_PLATFORM'],
          cpu: { level: 'unknown', cores: null, load1: null, load5: null, load15: null, ratio: null },
          browsers: { ...data.browsers, processes: 0, rssBytes: 0 },
        }}
      />,
    )
    expect(screen.getByText('System status is not available on this platform.')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuetext', 'n/a')
    expect(screen.getByRole('meter', { name: 'Browsers' }).children).toHaveLength(0)
  })
})
