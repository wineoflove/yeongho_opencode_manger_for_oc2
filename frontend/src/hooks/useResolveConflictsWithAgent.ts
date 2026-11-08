import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createSessionWithPrompt } from '@/api/opencode'
import { useOpenCodeServerId } from '@/contexts/OpenCodeServerContext'
import { buildConflictResolutionPrompt } from '@/lib/git-conflict-prompt'
import { getSessionPath } from '@/lib/navigation'
import { invalidateSessionListCaches } from '@/lib/queryInvalidation'
import { showToast } from '@/lib/toast'
import { t } from '@/i18n/translate'
import type { GitOperationState } from '@opencode-manager/shared'

interface ResolveConflictsInput {
  operation: GitOperationState
  branch: string
}

interface ResolveConflictsRepo {
  id: number
  fullPath: string
}

export function useResolveConflictsWithAgent(repo: ResolveConflictsRepo) {
  const serverId = useOpenCodeServerId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  return useMutation({
    mutationFn: async ({ operation, branch }: ResolveConflictsInput) => {
      return createSessionWithPrompt(
        {
          directory: repo.fullPath,
          title: t('Resolve {kind} conflicts', { kind: operation.kind }),
        },
        buildConflictResolutionPrompt({ operation, branch }),
        serverId,
      )
    },
    onSuccess: (session) => {
      invalidateSessionListCaches(queryClient)
      navigate(getSessionPath(repo.id, session.id))
    },
    onError: (error) => {
      showToast.error(
        t('Could not start conflict resolution: {reason}', { reason: error instanceof Error ? error.message : t('Unknown error') }),
      )
    },
  })
}
