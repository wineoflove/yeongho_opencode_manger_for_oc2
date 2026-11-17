import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { UsageWindow } from '@opencode-manager/shared/schemas'
import { UsageWindowRow } from './UsageWindowRow'

const HOUR_MS = 60 * 60 * 1000

function makeWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    key: 'five_hour',
    label: '5h window',
    ...overrides,
  }
}

describe('UsageWindowRow', () => {
  it('renders the window label', () => {
    render(<UsageWindowRow window={makeWindow()} />)

    expect(screen.getByText('5h window')).toBeInTheDocument()
  })

  it('derives the progress value from remaining and limit', () => {
    render(<UsageWindowRow window={makeWindow({ remaining: 25, limit: 100 })} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75')
    expect(screen.getByText('25/100')).toBeInTheDocument()
  })

  it('uses the destructive bar color at or above 90 percent', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 92 })} />)

    expect(screen.getByRole('progressbar').className).toContain('[&>div]:bg-destructive')
  })

  it('uses the amber bar color at or above 70 percent', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 75 })} />)

    const bar = screen.getByRole('progressbar')
    expect(bar.className).toContain('[&>div]:bg-amber-500')
    expect(bar.className).not.toContain('[&>div]:bg-destructive')
  })

  it('falls back to percent left when remaining and limit are missing', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 35 })} />)

    expect(screen.getByText('65% left')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35')
  })

  it('renders a dash when no usage figures are available', () => {
    render(<UsageWindowRow window={makeWindow()} />)

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('renders unknown reset copy when resetAt is missing', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 10 })} />)

    expect(screen.getByText('Reset time unknown')).toBeInTheDocument()
  })

  it('renders the reset notice when resetAt is in the past', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 10, resetAt: Date.now() - HOUR_MS })} />)

    expect(screen.getByText(/Window reset/)).toBeInTheDocument()
  })

  it('renders a countdown when resetAt is in the future', () => {
    render(<UsageWindowRow window={makeWindow({ usedPercent: 10, resetAt: Date.now() + 2 * HOUR_MS })} />)

    expect(screen.getByText(/Resets in/)).toBeInTheDocument()
  })
})
