import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Loader2 } from 'lucide-react'
import { t, tn } from '@/i18n/translate'

interface RestartServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onCancel: () => void
  isRestarting?: boolean
  activeSessionCount?: number
}

export function RestartServerDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  isRestarting = false,
  activeSessionCount,
}: RestartServerDialogProps) {
  const isConfirmDisabled = isRestarting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90%] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Restart OpenCode Server?')}</DialogTitle>
          <DialogDescription>
            {activeSessionCount && activeSessionCount > 0
              ? tn(
                  '{count} session is currently working. Restarting will interrupt it, and OpenCode resumes it automatically once the server is back.',
                  '{count} sessions are currently working. Restarting will interrupt them, and OpenCode resumes them automatically once the server is back.',
                  activeSessionCount,
                )
              : t('Restart the OpenCode server after your changes are saved to apply them to the running server.')
            }
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isRestarting}>
            {t('Later')}
          </Button>
          <Button onClick={onConfirm} disabled={isConfirmDisabled}>
            {isRestarting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {t('Restarting...')}
              </>
            ) : (
              t('Restart now')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
