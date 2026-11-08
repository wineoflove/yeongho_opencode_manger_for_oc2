import type { ReactNode } from 'react'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { t } from '@/i18n/translate'
import { tr } from '@/i18n/rich'

interface DeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  title: string
  description: ReactNode
  itemName?: string
  isDeleting?: boolean
  confirmLabel?: string
  pendingLabel?: string
  children?: ReactNode
}

export function DeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  title,
  description,
  itemName,
  isDeleting = false,
  confirmLabel,
  pendingLabel = t('Deleting...'),
  children
}: DeleteDialogProps) {
  return (
    <ConfirmDestructiveDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      title={title}
      description={description}
      warning={itemName ? (
        <>{tr('This will permanently delete "{name}". This action cannot be undone.', { name: <span className="font-medium">{itemName}</span> })}</>
      ) : undefined}
      confirmLabel={confirmLabel ?? (title.includes('Configuration') ? t('Delete Configuration') : t('Delete'))}
      pendingLabel={pendingLabel}
      isPending={isDeleting}
    >
      {children}
    </ConfirmDestructiveDialog>
  )
}
