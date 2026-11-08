import { useState, useEffect, useCallback } from 'react'
import type { PromptTemplate, CreatePromptTemplateRequest } from '@opencode-manager/shared/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { useCreatePromptTemplate, useUpdatePromptTemplate } from '@/hooks/usePromptTemplates'
import { t } from '@/i18n/translate'

type FormData = Pick<CreatePromptTemplateRequest, 'title' | 'category' | 'cadenceHint' | 'suggestedName' | 'suggestedDescription' | 'description' | 'prompt'>

const INITIAL_FORM: FormData = {
  title: '',
  category: '',
  cadenceHint: '',
  suggestedName: '',
  suggestedDescription: '',
  description: '',
  prompt: '',
}

interface PromptTemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  template?: PromptTemplate
  initialValues?: Partial<CreatePromptTemplateRequest>
}

function pickFormData(template?: PromptTemplate, initialValues?: Partial<CreatePromptTemplateRequest>): FormData {
  return {
    title: template?.title ?? initialValues?.title ?? '',
    category: template?.category ?? initialValues?.category ?? '',
    cadenceHint: template?.cadenceHint ?? initialValues?.cadenceHint ?? '',
    suggestedName: template?.suggestedName ?? initialValues?.suggestedName ?? '',
    suggestedDescription: template?.suggestedDescription ?? initialValues?.suggestedDescription ?? '',
    description: template?.description ?? initialValues?.description ?? '',
    prompt: template?.prompt ?? initialValues?.prompt ?? '',
  }
}

export function PromptTemplateDialog({ open, onOpenChange, template, initialValues }: PromptTemplateDialogProps) {
  const [form, setForm] = useState<FormData>(INITIAL_FORM)

  const createMutation = useCreatePromptTemplate()
  const updateMutation = useUpdatePromptTemplate()
  const isSaving = createMutation.isPending || updateMutation.isPending

  useEffect(() => {
    setForm(open ? pickFormData(template, initialValues) : INITIAL_FORM)
  }, [template, open, initialValues])

  const handleChange = useCallback((field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }, [])

  const handleSubmit = () => {
    const data: CreatePromptTemplateRequest = {
      title: form.title.trim(),
      category: form.category.trim(),
      cadenceHint: form.cadenceHint.trim(),
      suggestedName: form.suggestedName.trim(),
      suggestedDescription: form.suggestedDescription.trim(),
      description: form.description.trim(),
      prompt: form.prompt.trim(),
    }

    if (template) {
      updateMutation.mutate({ id: template.id, data }, { onSuccess: () => onOpenChange(false) })
    } else {
      createMutation.mutate(data, { onSuccess: () => onOpenChange(false) })
    }
  }

  const isValid = form.title.trim() && form.category.trim() && form.cadenceHint.trim() && form.suggestedName.trim() && form.prompt.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className=" flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden sm:h-auto sm:max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{template ? t('Edit template') : t('New template')}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="template-title">{t('Title')}</Label>
              <Input id="template-title" value={form.title} onChange={handleChange('title')} placeholder={t('Repo Health Report')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-category">{t('Category')}</Label>
              <Input id="template-category" value={form.category} onChange={handleChange('category')} placeholder={t('Health')} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="template-cadence">{t('Cadence hint')}</Label>
              <Input id="template-cadence" value={form.cadenceHint} onChange={handleChange('cadenceHint')} placeholder={t('Weekly')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-suggested-name">{t('Suggested job name')}</Label>
              <Input id="template-suggested-name" value={form.suggestedName} onChange={handleChange('suggestedName')} placeholder={t('Weekly repo health report')} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-description">{t('Description')}</Label>
            <Input id="template-description" value={form.description} onChange={handleChange('description')} placeholder={t('Short summary shown on the template card')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-suggested-description">{t('Suggested job description')}</Label>
            <Input id="template-suggested-description" value={form.suggestedDescription} onChange={handleChange('suggestedDescription')} placeholder={t('Pre-fills the schedule job description field')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-prompt">{t('Prompt')}</Label>
            <Textarea id="template-prompt" value={form.prompt} onChange={handleChange('prompt')} className="min-h-[200px]" placeholder={t('The full prompt sent to the agent when the schedule runs.')} />
          </div>
        </div>
        <div className="flex flex-row gap-2 pt-2 border-t border-border sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving} className="flex-1 sm:flex-none">{t('Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSaving || !isValid} className="flex-1 sm:flex-none">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isSaving ? t('Saving...') : template ? t('Save changes') : t('Create template')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
