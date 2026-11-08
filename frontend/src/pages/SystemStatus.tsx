import { RefreshCw } from 'lucide-react'
import { useSystemStatus } from '@/hooks/useSystemStatus'
import { SystemStatusContent } from '@/components/system/SystemStatusContent'
import { LiveStatusIndicator } from '@/components/system/LiveStatusIndicator'
import { Button } from '@/components/ui/button'
import { browserCategories, formatBytes, levelLabel, systemNumber } from '@/lib/systemStatus'
import { formatTime } from '@/i18n/format'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'

function DetailList({
  title,
  rows,
}: {
  readonly title: string
  readonly rows: readonly (readonly [string, string])[]
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <dl className="space-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function SystemStatus() {
  const query = useSystemStatus({ enabled: true })
  const data = query.data
  return (
    <div className="flex min-h-0 flex-1 min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0 space-y-1">
          <h1 className="text-lg font-semibold">{t('System status')}</h1>
          <LiveStatusIndicator dataUpdatedAt={query.dataUpdatedAt} errorUpdatedAt={query.errorUpdatedAt} />
        </div>
        <Button
          variant="outline"
          className="min-h-11 shrink-0 gap-2"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={cn('size-4', query.isFetching && 'motion-safe:animate-spin')} />
          {t('Refresh')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 md:pb-6 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <SystemStatusContent query={query} />
          {data && (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <DetailList
                  title={t('CPU')}
                  rows={[
                    [t('Cores'), systemNumber(data.cpu.cores)],
                    [
                      t('Load 1 / 5 / 15 minutes'),
                      [data.cpu.load1, data.cpu.load5, data.cpu.load15]
                        .map((value) => systemNumber(value, 2))
                        .join(' / '),
                    ],
                    [t('Load per core'), systemNumber(data.cpu.ratio, 2)],
                  ]}
                />
                <DetailList
                  title={t('Memory')}
                  rows={[
                    [t('Total memory'), formatBytes(data.memory.totalBytes)],
                    [
                      t('Free / used'),
                      [data.memory.freePercent, data.memory.usedPercent]
                        .map((value) => (value === null ? t('n/a') : `${systemNumber(value)}%`))
                        .join(' / '),
                    ],
                    [t('Memory pressure'), data.memory.pressure === null ? t('n/a') : levelLabel(data.memory.pressure)],
                    [
                      t('Swap used / total'),
                      `${formatBytes(data.memory.swapUsedBytes)} / ${formatBytes(data.memory.swapTotalBytes)}`,
                    ],
                  ]}
                />
              </div>
              <DetailList
                title={t('Browsers')}
                rows={browserCategories.map((category) => [
                  t(category.label),
                  t('{count} processes · {size}', {
                    count: systemNumber(data.browsers.categories[category.key].processes),
                    size: formatBytes(data.browsers.categories[category.key].rssBytes),
                  }),
                ])}
              />
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('Collected {time} · {platform}', {
                  time: formatTime(data.collectedAt, { seconds: true }),
                  platform: data.platform,
                })}
              </p>
            </>
          )}
          <p className="break-keep text-xs leading-relaxed text-muted-foreground">
            {t(
              'CPU: warning at 0.8 load/core, critical at 1.2. Memory: warning below 25% free, critical below 10%; reported pressure takes precedence. Linux PSI: warning at 10, critical at 40. Browsers: warning at 2 GB or 80 processes, critical at 4 GB.',
            )}
          </p>
          <p className="text-xs text-muted-foreground">{t('Read-only. OCM does not stop or restart processes.')}</p>
        </div>
      </div>
    </div>
  )
}
