import { ProviderPoolResponseSchema } from '@opencode-manager/shared/schemas'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export async function getProviderPool(providerId: string) {
  return ProviderPoolResponseSchema.parse(
    await fetchWrapper(`${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}/pool`),
  )
}
import { z } from 'zod'
import { ProviderPoolConfigureSchema } from '@opencode-manager/shared/schemas'

export async function configureProviderPool(providerId: string, input: z.infer<typeof ProviderPoolConfigureSchema>) {
  const body = ProviderPoolConfigureSchema.parse(input)
  const result = await fetchWrapper(`${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}/pool`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return z
    .object({
      saved: z.literal(true),
      applyStatus: z.enum(['applied', 'reloaded', 'restart_pending']),
    })
    .parse(result)
}
