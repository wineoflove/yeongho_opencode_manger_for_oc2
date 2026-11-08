import { useQuery } from '@tanstack/react-query'
import { fetchWorkflowSession } from '@/api/stats'

export function useWorkflowSession(sessionId: string) {
  return useQuery({
    queryKey: ['workflow-session', sessionId],
    queryFn: () => fetchWorkflowSession(sessionId),
    enabled: /^ses_[A-Za-z0-9]+$/.test(sessionId),
    retry: false,
  })
}
