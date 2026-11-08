import { API_BASE_URL } from '@/config'
import { ProviderRateLimitsResponseSchema } from '@opencode-manager/shared/schemas'
import { fetchWrapper } from './fetchWrapper'

export async function getProviderRateLimits(providerId: string) {
  const result = await fetchWrapper<unknown>(
    `${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}/rate-limits`,
  )
  return ProviderRateLimitsResponseSchema.parse(result)
}
