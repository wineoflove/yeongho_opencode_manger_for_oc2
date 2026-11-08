import { DeleteDialog } from '@/components/ui/delete-dialog'
import { t } from '@/i18n/translate'
import { tr } from '@/i18n/rich'

interface DeleteSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  isDeleting?: boolean
  sessionCount?: number
}

export function DeleteSessionDialog({ open, onOpenChange, onConfirm, onCancel, isDeleting = false, sessionCount = 1 }: DeleteSessionDialogProps) {
  const isMultiple = sessionCount > 1
  const title = isMultiple ? t('Delete Sessions') : t('Delete Session')
  const description = isMultiple 
    ? <>{tr('Are you sure you want to delete {count} sessions? This action cannot be undone.', { count: <span className="text-destructive font-bold text-lg">{sessionCount}</span> })}</>
    : t('Are you sure you want to delete this session? This action cannot be undone.')

  return (
    <DeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      title={title}
      description={description}
      isDeleting={isDeleting}
    />
  )
}
