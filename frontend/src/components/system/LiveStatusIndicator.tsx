import { useEffect, useState } from 'react'
import { formatLiveLabel, getLiveState } from '@/lib/systemStatus'
import { cn } from '@/lib/utils'
import { t } from '@/i18n/translate'

export function LiveStatusIndicator({
  dataUpdatedAt,
  errorUpdatedAt,
}: {
  readonly dataUpdatedAt: number
  readonly errorUpdatedAt: number
}) {
  const [clock, setClock] = useState(() => ({ now: Date.now(), hidden: document.hidden }))
  useEffect(() => {
    const update = () => setClock({ now: Date.now(), hidden: document.hidden })
    const timer = window.setInterval(update, 5000)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  if (dataUpdatedAt === 0 && errorUpdatedAt === 0)
    return <span className="text-xs text-muted-foreground">{t('Loading…')}</span>
  const input = { ...clock, dataUpdatedAt, errorUpdatedAt }
  const state = getLiveState(input)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          state === 'live' ? 'bg-emerald-500' : state === 'offline' ? 'bg-red-500' : 'bg-muted-foreground',
        )}
      />
      {formatLiveLabel(input)}
    </span>
  )
}
