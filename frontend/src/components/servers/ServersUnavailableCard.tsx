import { Server } from 'lucide-react'
import { LinkedServerStateCard } from '@/components/servers/LinkedServerStateCard'
import { t } from '@/i18n/translate'

interface ServersUnavailableCardProps {
  onRetry: () => void
}

/**
 * Shown on a linked-server screen while the server list is paused offline with no cached data, so
 * an unreachable server list is not mistaken for a server that was removed.
 */
export function ServersUnavailableCard({ onRetry }: ServersUnavailableCardProps) {
  return (
    <LinkedServerStateCard
      icon={Server}
      title={t('Servers unavailable')}
      description={t('Reconnect to load your linked servers.')}
      actionLabel={t('Retry')}
      onAction={onRetry}
    />
  )
}
