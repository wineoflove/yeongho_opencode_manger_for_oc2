import { useCallback, useEffect, useState } from 'react'
import { useBeforeUnload, useBlocker } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { t } from '@/i18n/translate'

/** Confirms before a route or directory change, or a page unload, would discard an in-progress file edit. */
export function FileNavigationGuard() {
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const onEditMode = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (
        typeof detail === 'object' &&
        detail !== null &&
        'isEditing' in detail &&
        typeof detail.isEditing === 'boolean'
      )
        setEditing(detail.isEditing)
    }
    window.addEventListener('editModeChange', onEditMode)
    return () => window.removeEventListener('editModeChange', onEditMode)
  }, [])
  useBeforeUnload(
    useCallback(
      (event) => {
        if (editing) {
          event.preventDefault()
          event.returnValue = ''
        }
      },
      [editing],
    ),
  )
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      editing &&
      (currentLocation.pathname !== nextLocation.pathname ||
        new URLSearchParams(currentLocation.search).get('directory') !==
          new URLSearchParams(nextLocation.search).get('directory')),
  )
  const keepEditing = () => {
    if (blocker.state === 'blocked') blocker.reset()
  }
  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open) keepEditing()
      }}
    >
      <DialogContent className="z-[300] max-w-sm" overlayClassName="z-[300]">
        <DialogHeader>
          <DialogTitle>{t('Unsaved Changes')}</DialogTitle>
          <DialogDescription>{t('You have unsaved edits.')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={keepEditing}>
            {t('Keep Editing')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (blocker.state === 'blocked') blocker.proceed()
            }}
          >
            {t('Discard')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
