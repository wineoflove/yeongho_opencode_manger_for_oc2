import { useQuery } from '@tanstack/react-query'
import { getProviderPool } from '@/api/providerPool'

export function useProviderPool(providerId: string) {
  return useQuery({
    queryKey: ['provider-pool', providerId],
    queryFn: () => getProviderPool(providerId),
    retry: false,
  })
}
