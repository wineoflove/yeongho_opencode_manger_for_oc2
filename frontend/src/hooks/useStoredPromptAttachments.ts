import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteStoredPromptAttachment, listStoredPromptAttachments } from '@/api/promptAttachments'

const STORED_PROMPT_ATTACHMENTS_QUERY_KEY = ['stored-prompt-attachments'] as const

export function useStoredPromptAttachments() {
  return useQuery({
    queryKey: STORED_PROMPT_ATTACHMENTS_QUERY_KEY,
    queryFn: listStoredPromptAttachments,
  })
}

export function useDeleteStoredPromptAttachment() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteStoredPromptAttachment(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STORED_PROMPT_ATTACHMENTS_QUERY_KEY }),
  })
}
