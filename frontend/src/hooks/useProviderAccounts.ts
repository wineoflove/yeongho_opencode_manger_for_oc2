import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { providerAccountsApi } from '@/api/provider-accounts'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'

type AccountAction =
  | {
      readonly kind: 'activate'
      readonly integrationId: string
      readonly accountId: string
    }
  | {
      readonly kind: 'rename'
      readonly integrationId: string
      readonly accountId: string
      readonly label: string
    }
  | {
      readonly kind: 'remove'
      readonly integrationId: string
      readonly accountId: string
    }

export function useProviderAccounts(integrationId: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['provider-accounts', integrationId],
    queryFn: () => providerAccountsApi.list(integrationId),
    enabled: integrationId.length > 0,
  })
  const mutation = useMutation({
    mutationFn: async (action: AccountAction) => {
      switch (action.kind) {
        case 'activate':
          return providerAccountsApi.activate(action.integrationId, action.accountId)
        case 'rename':
          return providerAccountsApi.rename(action.integrationId, action.accountId, action.label)
        case 'remove':
          return providerAccountsApi.remove(action.integrationId, action.accountId)
      }
    },
    onSettled: () => invalidateProviderCaches(queryClient),
  })
  return { query, mutation }
}
