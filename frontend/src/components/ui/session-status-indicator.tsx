import { memo } from 'react'
import { ActivitySpinner } from '@/components/ui/activity-spinner'
import { useHasBackgroundActivity, useSessionStatusForSession } from '@/stores/sessionStatusStore'
import { t } from '@/i18n/translate'

interface SessionStatusIndicatorProps {
  sessionID: string
  className?: string
}

/**
 * Shows a session's activity as the braille spinner sized for list rows.
 * Renders nothing while the session is idle and has no background activity.
 */
export const SessionStatusIndicator = memo(function SessionStatusIndicator({
  sessionID,
  className = '',
}: SessionStatusIndicatorProps) {
  const status = useSessionStatusForSession(sessionID)
  const hasBackground = useHasBackgroundActivity(sessionID)
  const backgroundOnly = status.type === 'idle' && hasBackground

  if (status.type === 'idle' && !hasBackground) {
    return null
  }

  const colorClass = backgroundOnly
    ? 'text-muted-foreground'
    : status.type === 'retry'
      ? 'text-warning'
      : status.type === 'compact'
        ? 'text-primary'
        : 'text-info'
  const label = backgroundOnly
    ? t('Background tasks running')
    : status.type === 'retry'
      ? t('Retrying')
      : status.type === 'compact'
        ? t('Compacting')
        : t('Running')

  return (
    <span
      role="img"
      aria-label={label}
      title={backgroundOnly ? label : undefined}
      className={`inline-flex items-center ${colorClass} ${className}`}
    >
      <ActivitySpinner />
    </span>
  )
})
