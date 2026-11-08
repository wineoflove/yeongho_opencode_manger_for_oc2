import { useMemo } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { LOCAL_OPENCODE_SERVER_ID } from '@opencode-manager/shared/schemas'
import { listSessionMessages } from '@/api/opencode'
import { sessionTranscriptQueryKey } from '@/lib/queryInvalidation'
import { serverScopedKey } from '@/lib/serverScope'
import { getTodoProgress, latestSessionTodos, type TodoProgress } from '@/lib/sessionTodos'
import type { TranscriptCache } from '@/lib/session-projection'

export interface SessionTodoTarget {
  key: string
  sessionID: string
  serverId?: string
}

const TODO_PROGRESS_PAGE_SIZE = 100
const TODO_PROGRESS_REFRESH_MS = 15_000

/**
 * Todo progress for a bounded set of sessions, such as the active rows of the session picker. OpenCode 2 keeps
 * no todo state of its own, so each session's progress comes from the latest `todowrite` call in its transcript:
 * the cached transcript when the session was opened, otherwise its newest message page.
 */
export function useSessionTodoProgress(targets: readonly SessionTodoTarget[], enabled: boolean) {
  const queryClient = useQueryClient()
  const data = useQueries({
    queries: targets.map((target) => {
      const serverId = target.serverId ?? LOCAL_OPENCODE_SERVER_ID
      return {
        queryKey: ['opencode', 'session-todo-progress', serverId, target.sessionID],
        queryFn: async (): Promise<TodoProgress | null> => {
          const cached = queryClient.getQueryData<TranscriptCache>(
            serverScopedKey(sessionTranscriptQueryKey(target.sessionID), serverId),
          )
          const messages =
            cached?.transcript.messages ??
            (await listSessionMessages(target.sessionID, { limit: TODO_PROGRESS_PAGE_SIZE }, serverId)).messages
          return getTodoProgress(latestSessionTodos(messages))
        },
        enabled,
        staleTime: TODO_PROGRESS_REFRESH_MS,
        refetchInterval: enabled ? TODO_PROGRESS_REFRESH_MS : (false as const),
        retry: false,
      }
    }),
    combine: (results) => results.map((result) => result.data ?? null),
  })

  return useMemo(() => {
    const progress = new Map<string, TodoProgress>()
    targets.forEach((target, index) => {
      const value = data[index]
      if (value) progress.set(target.key, value)
    })
    return progress
  }, [data, targets])
}
