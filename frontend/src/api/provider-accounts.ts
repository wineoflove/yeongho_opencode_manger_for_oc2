import { API_BASE_URL } from '@/config'
import {
  ProviderAccountsResponseSchema,
  ProviderAccountActivationResponseSchema,
  ProviderAccountRenameRequestSchema,
  ProviderAccountRenameResponseSchema,
  ProviderAccountDeletionResponseSchema,
} from '@opencode-manager/shared/schemas'
import { fetchWrapper } from './fetchWrapper'

function accountsPath(integrationId: string, accountId?: string): string {
  const root = `${API_BASE_URL}/api/providers/${encodeURIComponent(integrationId)}/accounts`
  return accountId === undefined ? root : `${root}/${encodeURIComponent(accountId)}`
}

export const providerAccountsApi = {
  async list(integrationId: string) {
    return ProviderAccountsResponseSchema.parse(await fetchWrapper<unknown>(accountsPath(integrationId)))
  },
  async activate(integrationId: string, accountId: string) {
    return ProviderAccountActivationResponseSchema.parse(
      await fetchWrapper<unknown>(`${accountsPath(integrationId, accountId)}/activate`, { method: 'POST' }),
    )
  },
  async rename(integrationId: string, accountId: string, label: string) {
    const body = ProviderAccountRenameRequestSchema.parse({ label })
    return ProviderAccountRenameResponseSchema.parse(
      await fetchWrapper<unknown>(accountsPath(integrationId, accountId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  },
  async remove(integrationId: string, accountId: string) {
    return ProviderAccountDeletionResponseSchema.parse(
      await fetchWrapper<unknown>(accountsPath(integrationId, accountId), {
        method: 'DELETE',
      }),
    )
  },
}
