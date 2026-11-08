import { useEffect, useMemo, useState } from 'react'
import type { ImageAttachment } from '@/api/types'
import { readPromptAttachment } from '@/lib/promptAttachments'
import { showToast } from '@/lib/toast'
import { t } from '@/i18n/translate'

export function usePromptFileUploads(
  session: { readonly directory?: string; readonly sessionID: string },
  onAttachment: (attachment: ImageAttachment) => void,
) {
  const scope = useMemo(
    () => ({ pending: 0, active: true, directory: session.directory, sessionID: session.sessionID }),
    [session.directory, session.sessionID],
  )
  const [pending, setPending] = useState(0)
  useEffect(() => {
    scope.active = true
    setPending(0)
    return () => {
      scope.active = false
    }
  }, [scope])

  const addFileAttachments = async (files: Iterable<File>) => {
    scope.pending += 1
    setPending(scope.pending)
    try {
      for (const file of files) {
        if (!scope.active) break
        const result = await readPromptAttachment(file, scope.directory)
        if (!scope.active) break
        if (result.ok) onAttachment(result.attachment)
        else showToast.error(t(result.reason))
      }
    } finally {
      scope.pending -= 1
      if (scope.active) setPending(scope.pending)
    }
  }

  return { addFileAttachments, isUploading: pending > 0, hasPendingUploads: () => scope.pending > 0 }
}
