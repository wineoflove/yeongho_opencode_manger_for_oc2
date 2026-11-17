import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { claudeProxyApi } from '@/api/claudeProxy'

const accountsQueryKey = ['claude-proxy', 'accounts'] as const

/** Who manages Claude and OpenAI accounts: still checking, unknown after a failed check, CLIProxy, or OpenCode. */
export type ClaudeProxyOwnership = 'checking' | 'unavailable' | 'proxy' | 'native'

export function useClaudeProxy() {
  const status = useQuery({
    queryKey: ['claude-proxy', 'ownership'],
    queryFn: claudeProxyApi.status,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const ownership: ClaudeProxyOwnership = status.isError
    ? 'unavailable'
    : status.isPending || status.isFetching
      ? 'checking'
      : status.data.ownsInference
        ? 'proxy'
        : 'native'
  const accounts = useQuery({
    queryKey: accountsQueryKey,
    queryFn: claudeProxyApi.accounts,
    enabled: ownership === 'proxy',
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  return { ownership, status, accounts }
}

/** State of CLIProxy ownership and its account list, as returned by {@link useClaudeProxy}. */
export type ClaudeProxyState = ReturnType<typeof useClaudeProxy>

function useAccountsRefresh() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: accountsQueryKey })
}

/** Turns one CLIProxy account on or off; settles only after the account list is reloaded. */
export function useClaudeProxyAccountUpdate() {
  const refresh = useAccountsRefresh()
  return useMutation({
    mutationFn: ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) =>
      claudeProxyApi.setAccountEnabled(id, enabled),
    onSettled: refresh,
  })
}

/** Deletes one CLIProxy account; settles only after the account list is reloaded. */
export function useClaudeProxyAccountRemoval() {
  const refresh = useAccountsRefresh()
  return useMutation({
    mutationFn: (id: string) => claudeProxyApi.deleteAccount(id),
    onSettled: refresh,
  })
}

/**
 * Starts and completes a CLIProxy sign-in. The completion never pauses offline and leaves the
 * mutation cache as soon as it settles, so the pasted redirect address is not kept or persisted.
 */
export function useClaudeProxyLogin() {
  const refresh = useAccountsRefresh()
  const start = useMutation({
    mutationFn: claudeProxyApi.startLogin,
    gcTime: 0,
  })
  const complete = useMutation({
    mutationFn: claudeProxyApi.completeLogin,
    networkMode: 'always',
    gcTime: 0,
    onSettled: refresh,
  })
  return { start, complete }
}
