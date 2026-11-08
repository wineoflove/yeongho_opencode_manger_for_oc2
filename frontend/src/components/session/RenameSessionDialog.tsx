import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n/translate'

export interface RenameSessionDialogProps {
  open: boolean
  currentTitle: string
  onOpenChange: (open: boolean) => void
  onSave: (title: string) => Promise<void>
}

/** Renames a session from a list without opening it; keeps the dialog open with an error when saving fails. */
export function RenameSessionDialog({ open, currentTitle, onOpenChange, onSave }: RenameSessionDialogProps) {
  const [draft, setDraft] = useState(currentTitle)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [lastOpen, setLastOpen] = useState(open)

  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setDraft(currentTitle)
      setFailed(false)
    }
  }

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== currentTitle.trim() && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave(trimmed)
      onOpenChange(false)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Rename session')}</DialogTitle>
        </DialogHeader>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== 'Enter') return
            event.preventDefault()
            void save()
          }}
          disabled={saving}
          aria-label={t('Session title')}
          autoFocus
          className="w-full min-w-0 rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
        />
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            {t('Rename failed')}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('Cancel')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
