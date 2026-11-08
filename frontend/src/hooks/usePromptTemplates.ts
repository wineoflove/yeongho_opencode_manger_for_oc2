import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreatePromptTemplateRequest, UpdatePromptTemplateRequest } from '@opencode-manager/shared/types'
import {
  listPromptTemplates,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
} from '@/api/prompt-templates'
import { showToast } from '@/lib/toast'
import { t } from '@/i18n/translate'

export function usePromptTemplates() {
  return useQuery({
    queryKey: ['prompt-templates'],
    queryFn: async () => {
      const response = await listPromptTemplates()
      return response.templates
    },
  })
}

export function useCreatePromptTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: CreatePromptTemplateRequest) => createPromptTemplate(data).then(r => r.template),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompt-templates'] })
      showToast.success(t('Template created'))
    },
    onError: (error) => {
      showToast.error(t('Failed to create template: {error}', { error: error instanceof Error ? error.message : String(error) }))
    },
  })
}

export function useUpdatePromptTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdatePromptTemplateRequest }) =>
      updatePromptTemplate(id, data).then(r => r.template),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompt-templates'] })
      showToast.success(t('Template updated'))
    },
    onError: (error) => {
      showToast.error(t('Failed to update template: {error}', { error: error instanceof Error ? error.message : String(error) }))
    },
  })
}

export function useDeletePromptTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deletePromptTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompt-templates'] })
      showToast.success(t('Template deleted'))
    },
    onError: (error) => {
      showToast.error(t('Failed to delete template: {error}', { error: error instanceof Error ? error.message : String(error) }))
    },
  })
}
