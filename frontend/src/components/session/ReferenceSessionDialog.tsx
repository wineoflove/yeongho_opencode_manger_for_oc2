import { Loader2 } from 'lucide-react'
import { t } from '@/i18n/translate'
import { tr } from '@/i18n/rich'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ReferenceSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  location: string
  promptPreview: string
  isPending: boolean
  onConfirm: () => void
}

/** Confirms creating a new session in the same project and directory with a reference to this session drafted in its composer. */
export function ReferenceSessionDialog({
  open,
  onOpenChange,
  projectName,
  location,
  promptPreview,
  isPending,
  onConfirm,
}: ReferenceSessionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isPending) onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-[92%] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Start a new session from this one?')}</DialogTitle>
          <DialogDescription>
            {tr(
              "Creates a new session in the same project ({project}) and working directory ({location}), then puts this session's ID in the message box. Nothing is sent automatically.",
              {
                project: <span className="font-medium text-foreground">{projectName}</span>,
                location: <span className="font-medium text-foreground">{location}</span>,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
          {promptPreview.trimEnd()}
        </pre>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="flex-1 sm:flex-none"
          >
            {t('Cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={isPending} className="flex-1 sm:flex-none">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isPending ? t('Creating…') : t('New session')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
