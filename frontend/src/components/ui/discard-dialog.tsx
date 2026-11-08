import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { t } from '@/i18n/translate'

interface DiscardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  fileCount: number
  isDiscarding?: boolean
}

export function DiscardDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  fileCount,
  isDiscarding = false
}: DiscardDialogProps) {
  const itemText = fileCount === 1 ? '1 file' : `${fileCount} files`

  return (
    <ConfirmDestructiveDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      title={t('Discard Changes')}
      description={t('Are you sure you want to discard changes to {items}? This action cannot be undone.', { items: itemText })}
      warning={t('This will permanently delete your uncommitted changes to {items}. If these changes exist in the staging area, they will also be removed.', { items: itemText })}
      confirmLabel={t('Discard')}
      pendingLabel={t('Discarding...')}
      isPending={isDiscarding}
    />
  )
}
