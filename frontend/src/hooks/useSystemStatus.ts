import { useQuery } from '@tanstack/react-query'
import { fetchSystemStatus } from '@/api/system'

export function useSystemStatus({ enabled }: { readonly enabled: boolean }) {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
    retry: 1,
  })
}
