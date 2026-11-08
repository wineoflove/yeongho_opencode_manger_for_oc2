import { useQuery } from '@tanstack/react-query'
import { fetchLearningLint } from '@/api/stats'

export function useLearningLint() {
  return useQuery({
    queryKey: ['learning-lint'],
    queryFn: fetchLearningLint,
    refetchInterval: 300_000,
    retry: false,
  })
}
