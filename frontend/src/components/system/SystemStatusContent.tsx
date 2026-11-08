import type { useSystemStatus } from '@/hooks/useSystemStatus'
import { SystemStatusCard } from './SystemStatusCard'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n/translate'

export function SystemStatusContent({
  query,
  compact = false,
}: {
  readonly query: ReturnType<typeof useSystemStatus>
  readonly compact?: boolean
}) {
  if (query.data) return <SystemStatusCard data={query.data} compact={compact} />
  if (query.isError)
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-border p-4 text-sm">
        <p>{t("Couldn't load system status.")}</p>
        <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {t('Retry')}
        </Button>
      </div>
    )
  return (
    <div role="status" aria-label={t('Loading…')} className="space-y-5 rounded-lg border border-border bg-card p-4">
      <div className="h-5 w-28 rounded bg-muted" />
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-16 rounded bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  )
}
