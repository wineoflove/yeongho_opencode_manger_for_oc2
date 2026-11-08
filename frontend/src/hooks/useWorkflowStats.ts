import { useQuery } from '@tanstack/react-query'
import type { WorkflowRange } from '@opencode-manager/shared/schemas'
import { fetchWorkflowStats } from '@/api/stats'

export function useWorkflowStats(range: WorkflowRange) {
  return useQuery({
    queryKey: ['workflow-stats', range],
    queryFn: () => fetchWorkflowStats(range),
    refetchInterval: 300_000,
    retry: false,
  })
}
