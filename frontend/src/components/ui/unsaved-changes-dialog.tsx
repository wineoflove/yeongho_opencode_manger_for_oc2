import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { t } from '@/i18n/translate'

interface UnsavedChangesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDiscard: () => void
  onKeepEditing: () => void
  itemName?: string
}

export function UnsavedChangesDialog({
  open,
  onOpenChange,
  onDiscard,
  onKeepEditing,
  itemName,
}: UnsavedChangesDialogProps) {
  return (
    <ConfirmDestructiveDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onDiscard}
      onCancel={onKeepEditing}
      title={t('Unsaved Changes')}
      description={itemName ? t('You have unsaved edits to {name}.', { name: itemName }) : t('You have unsaved edits.')}
      warning={t('Discarding will permanently lose these edits.')}
      confirmLabel={t('Discard')}
      cancelLabel={t('Keep Editing')}
    />
  )
}
