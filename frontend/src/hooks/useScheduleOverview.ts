import { useQuery } from '@tanstack/react-query'
import { fetchScheduleOverview } from '@/api/schedules'

export function useScheduleOverview(windowDays: 1 | 7 | 30) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return useQuery({
    queryKey: ['schedule-overview', windowDays, tz],
    queryFn: () => fetchScheduleOverview(windowDays, tz),
    refetchInterval: (query) => (query.state.data?.running.length ? 30_000 : 60_000),
  })
}
