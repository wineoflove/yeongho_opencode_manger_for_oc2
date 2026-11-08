import { ProviderExternalLoginResponseSchema } from '@opencode-manager/shared/schemas'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

const endpoint = `${API_BASE_URL}/api/providers/claude-agent/external-login`

export const providerExternalApi = {
  getStatus: async () => ProviderExternalLoginResponseSchema.parse(await fetchWrapper<unknown>(endpoint)),
  connect: async () =>
    ProviderExternalLoginResponseSchema.parse(await fetchWrapper<unknown>(endpoint, { method: 'POST' })),
}
