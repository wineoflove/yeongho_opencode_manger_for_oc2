import { useCallback, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fetchTokenStats } from '@/api/stats'
import { rangeWindow, type StatsViewState } from '@/lib/tokenStats'

const AUTO_REFRESH_INTERVAL_MS = 30_000
const AUTO_REFRESH_STORAGE_KEY = 'oc:stats:auto-refresh'

export function useTokenStats(state: StatsViewState, autoRefresh = true) {
  return useQuery({
    queryKey: ['token-stats', state.range, state.groupBy, state.splitBy, state.filters],
    enabled: state.view !== 'workflow',
    queryFn: () =>
      fetchTokenStats({
        ...rangeWindow(state.range, Date.now()),
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
        groupBy: state.groupBy,
        splitBy: state.splitBy,
        filters: state.filters,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL_MS : false,
    retry: 1,
  })
}

export function useStatsAutoRefresh(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(
    () => typeof window === 'undefined' || localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== 'false',
  )
  const update = useCallback((next: boolean) => {
    setEnabled(next)
    if (typeof window !== 'undefined') localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(next))
  }, [])
  return [enabled, update]
}
