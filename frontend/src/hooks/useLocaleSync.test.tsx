import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLocaleSync } from './useLocaleSync'
import { useSettings } from './useSettings'
import { settingsApi } from '@/api/settings'
import { getLocale, resetLocaleStateForTests, setLocale } from '@/i18n/locale'
import type { SettingsResponse, UserPreferences } from '@/api/types/settings'

vi.mock('@/api/settings', () => ({
  settingsApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    resetSettings: vi.fn(),
  },
}))

const basePreferences: UserPreferences = {
  theme: 'dark',
  mode: 'build',
  autoScroll: true,
  expandDiffs: true,
  expandToolCalls: false,
  showReasoning: false,
  simpleChatMode: false,
  keyboardShortcuts: {},
  customCommands: [],
}

const koSettings: SettingsResponse = { preferences: { ...basePreferences, locale: 'ko' }, updatedAt: 1 }

function createQueryClient(settings: SettingsResponse): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['settings', 'default'], settings)
  return queryClient
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function useSyncedSettings() {
  useLocaleSync()
  return useSettings()
}

describe('useLocaleSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocaleStateForTests()
    vi.mocked(settingsApi.getSettings).mockResolvedValue(koSettings)
  })

  it('applies the locale stored in server settings', () => {
    renderHook(() => useLocaleSync(), { wrapper: wrapperFor(createQueryClient(koSettings)) })

    expect(getLocale()).toBe('ko')
    expect(document.documentElement.lang).toBe('ko')
  })

  it('keeps the current locale when server settings have no locale', () => {
    renderHook(() => useLocaleSync(), {
      wrapper: wrapperFor(createQueryClient({ preferences: basePreferences, updatedAt: 1 })),
    })

    expect(getLocale()).toBe('en')
  })

  it('keeps the user choice when a redraw replays the stale server locale', () => {
    const wrapper = wrapperFor(createQueryClient(koSettings))
    const first = renderHook(() => useLocaleSync(), { wrapper })
    expect(getLocale()).toBe('ko')

    act(() => setLocale('en'))
    first.rerender()
    first.unmount()
    renderHook(() => useLocaleSync(), { wrapper })

    expect(getLocale()).toBe('en')
    expect(localStorage.getItem('oc:locale')).toBe('en')
  })

  it('switches to the server locale when a failed save rolls the cache back', async () => {
    let rejectSave: (reason: Error) => void = () => {}
    vi.mocked(settingsApi.updateSettings).mockImplementation(
      () =>
        new Promise<SettingsResponse>((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    const { result } = renderHook(() => useSyncedSettings(), {
      wrapper: wrapperFor(createQueryClient(koSettings)),
    })
    expect(getLocale()).toBe('ko')

    act(() => {
      setLocale('en')
      result.current.updateSettings({ locale: 'en' })
    })
    await waitFor(() => expect(result.current.preferences?.locale).toBe('en'))
    expect(getLocale()).toBe('en')

    act(() => rejectSave(new Error('save failed')))

    await waitFor(() => expect(getLocale()).toBe('ko'))
    expect(result.current.preferences?.locale).toBe('ko')
  })
})
