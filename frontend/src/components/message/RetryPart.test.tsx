import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '@/i18n/locale'
import { RetryPart } from './RetryPart'

describe('localized retry countdown', () => {
  it('counts down in Korean while retaining the provider error and clearing its timer', async () => {
    const previous = getLocale()
    setLocale('ko')
    vi.useFakeTimers()
    const { unmount } = render(
      <RetryPart
        retry={{
          attempt: 2,
          at: Date.now() + 2000,
          error: {
            type: 'ProviderError',
            message: 'Original provider diagnostic',
          },
        }}
      />,
    )
    try {
      expect(screen.getByText('(2초 후 재시도)')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(screen.getByText('(1초 후 재시도)')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(screen.queryByText('(1초 후 재시도)')).not.toBeInTheDocument()
      expect(screen.getByText('Original provider diagnostic')).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unmount()
      vi.useRealTimers()
      setLocale(previous)
    }
  })
})
