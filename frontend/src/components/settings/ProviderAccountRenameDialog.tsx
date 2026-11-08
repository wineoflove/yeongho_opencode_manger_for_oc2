import { useId, useState } from 'react'
import { ProviderAccountRenameRequestSchema, type ProviderAccount } from '@opencode-manager/shared/schemas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { t } from '@/i18n/translate'

export function ProviderAccountRenameDialog({
  account,
  pending,
  failed,
  onClose,
  onSave,
}: {
  readonly account: ProviderAccount
  readonly pending: boolean
  readonly failed: boolean
  readonly onClose: () => void
  readonly onSave: (label: string) => void
}) {
  const inputId = useId()
  const [label, setLabel] = useState(account.label)
  const parsed = ProviderAccountRenameRequestSchema.safeParse({ label })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Rename saved account')}</DialogTitle>
          <DialogDescription className="break-keep">
            {t('Change the display name without changing authentication or the selected account.')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed.success && !pending) onSave(parsed.data.label)
          }}
        >
          <div className="space-y-2">
            <label htmlFor={inputId} className="text-sm font-medium">
              {t('Account name')}
            </label>
            <Input
              id={inputId}
              autoFocus
              value={label}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              {t('Account rename could not be confirmed. Your input has been kept.')}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" className="min-w-20" disabled={pending || !parsed.success}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
