import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AccountUsage } from '@opencode-manager/shared/schemas'
import { setLocale } from '../../i18n/locale'
import { AccountUsageCard } from './AccountUsageCard'

const account: AccountUsage = {
  provider: 'anthropic',
  accountKey: 'fixture',
  label: 'Original account',
  enabled: true,
  state: 'ok',
  confidence: 'fresh',
  updatedAt: new Date(2026, 9, 14, 18, 45).getTime(),
  windows: [{ key: 'five_hour', label: '5 hours', usedPercent: 25, resetAt: new Date(2026, 9, 14, 19, 50).getTime() }],
}

beforeEach(() => {
  setLocale('ko')
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 14, 18, 50))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setLocale('en')
})

it('renders Korean limit labels, relative observation time and absolute reset time', () => {
  render(<AccountUsageCard account={account} />)

  expect(screen.getByText('Original account')).toBeInTheDocument()
  expect(screen.getByText('활성')).toBeInTheDocument()
  expect(screen.getByText('5시간')).toBeInTheDocument()
  expect(screen.getByText('75% 남음')).toBeInTheDocument()
  expect(screen.getByText('1시간 00분 후 재설정 · 10월 14일 19:50')).toBeInTheDocument()
  expect(screen.getByText(/5분 전/)).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
})

it('distinguishes historical usage from an active account', () => {
  render(<AccountUsageCard account={{ ...account, confidence: 'stale' }} />)

  expect(screen.getByText('활성')).toBeInTheDocument()
  expect(screen.getByText('마지막으로 확인된 사용량')).toBeInTheDocument()
  expect(screen.getByText('마지막으로 보고된 재설정: 10월 14일 19:50')).toBeInTheDocument()
})
