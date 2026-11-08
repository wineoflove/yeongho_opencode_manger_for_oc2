import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  applyServerLocale,
  getLocale,
  resetLocaleStateForTests,
  setLocale,
  subscribeLocale,
  useLocale,
} from './locale'

describe('locale', () => {
  beforeEach(() => {
    resetLocaleStateForTests()
    setLocale('en')
  })

  it('defaults to ko', () => {
    expect(DEFAULT_LOCALE).toBe('ko')
    expect(LOCALE_STORAGE_KEY).toBe('oc:locale')
  })

  it('setLocale updates storage, html lang and subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocale(listener)

    setLocale('ko')

    expect(getLocale()).toBe('ko')
    expect(localStorage.getItem('oc:locale')).toBe('ko')
    expect(document.documentElement.lang).toBe('ko')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('setLocale with the same value does nothing', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocale(listener)

    setLocale('en')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('unsubscribed listeners are not called', () => {
    const listener = vi.fn()
    subscribeLocale(listener)()

    setLocale('ko')

    expect(listener).not.toHaveBeenCalled()
  })

  it('useLocale re-renders on change', () => {
    const { result } = renderHook(() => useLocale())
    expect(result.current).toBe('en')

    act(() => setLocale('ko'))

    expect(result.current).toBe('ko')
  })

  it('applyServerLocale ignores undefined', () => {
    applyServerLocale(undefined)

    expect(getLocale()).toBe('en')
  })

  it('applyServerLocale does not revert a user choice with a stale server value', () => {
    applyServerLocale('ko')
    expect(getLocale()).toBe('ko')

    setLocale('en')
    applyServerLocale('ko')

    expect(getLocale()).toBe('en')
  })

  it('applyServerLocale applies a changed server value', () => {
    applyServerLocale('ko')
    setLocale('en')
    applyServerLocale('en')

    applyServerLocale('ko')

    expect(getLocale()).toBe('ko')
  })
})

describe('locale initial state', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('uses a stored valid locale', async () => {
    localStorage.setItem('oc:locale', 'en')

    const fresh = await import('./locale')

    expect(fresh.getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to ko for an unknown stored value', async () => {
    localStorage.setItem('oc:locale', 'fr')

    const fresh = await import('./locale')

    expect(fresh.getLocale()).toBe('ko')
    expect(document.documentElement.lang).toBe('ko')
  })

  it('falls back to ko when nothing is stored', async () => {
    localStorage.removeItem('oc:locale')

    const fresh = await import('./locale')

    expect(fresh.getLocale()).toBe('ko')
  })
})
