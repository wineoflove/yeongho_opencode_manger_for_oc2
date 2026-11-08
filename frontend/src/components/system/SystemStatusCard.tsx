import { Link } from 'react-router-dom'
import type { SystemLevel, SystemStatusResponse } from '@opencode-manager/shared/schemas'
import { browserCategories, formatBytes, levelLabel, segmentsFilled, systemNumber } from '@/lib/systemStatus'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'

const levelColor: Record<SystemLevel, string> = {
  normal: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  unknown: 'bg-muted-foreground',
}

function Level({ level }: { readonly level: SystemLevel }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', levelColor[level])} />
      {levelLabel(level)}
    </span>
  )
}

function SegmentedMeter({
  value,
  label,
  level,
}: {
  readonly value: number | null
  readonly label: string
  readonly level: SystemLevel
}) {
  const percent = value === null ? null : Math.round(value * 100)
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))}
        aria-valuetext={percent === null ? t('n/a') : `${systemNumber(percent)}%`}
        className="flex h-2.5 min-w-0 flex-1 gap-1"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <span
            key={index}
            className={cn(
              'min-w-0 flex-1 rounded-sm',
              value !== null && index < segmentsFilled(value) ? levelColor[level] : 'bg-muted',
            )}
          />
        ))}
      </div>
      <span className="w-10 text-right text-xs tabular-nums">
        {percent === null ? t('n/a') : `${systemNumber(percent)}%`}
      </span>
    </div>
  )
}

export function SystemStatusCard({
  data,
  compact = false,
}: {
  readonly data: SystemStatusResponse
  readonly compact?: boolean
}) {
  const { cpu, memory, browsers } = data
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4 shadow-sm">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">{t('System')}</h2>
          <span className="text-xs text-muted-foreground">{t('every 30s')}</span>
        </div>
        <Level level={data.overall} />
        {compact && (
          <Link
            to="/system"
            className="flex min-h-8 w-full items-center justify-end text-xs text-muted-foreground hover:text-foreground"
          >
            {t('Details →')}
          </Link>
        )}
      </header>
      {data.overall === 'unknown' && data.errors.includes('UNSUPPORTED_PLATFORM') && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t('System status is not available on this platform.')}
        </p>
      )}
      <div className="space-y-5">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="flex items-center gap-2 font-medium">
              {t('CPU')}
              <Level level={cpu.level} />
            </span>
            <span className="tabular-nums">
              {t('{load} / {cores} cores', { load: systemNumber(cpu.load1, 2), cores: systemNumber(cpu.cores) })}
            </span>
          </div>
          <SegmentedMeter value={cpu.ratio} label={t('CPU')} level={cpu.level} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('Load 5m {load5} · 15m {load15}', {
              load5: systemNumber(cpu.load5, 2),
              load15: systemNumber(cpu.load15, 2),
            })}
          </p>
        </section>
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="flex items-center gap-2 font-medium">
              {t('Memory')}
              <Level level={memory.level} />
            </span>
            <span className="tabular-nums">
              {memory.freePercent === null
                ? t('n/a')
                : t('{percent}% free', { percent: systemNumber(memory.freePercent) })}
            </span>
          </div>
          <SegmentedMeter
            value={memory.usedPercent === null ? null : memory.usedPercent / 100}
            label={t('Memory')}
            level={memory.level}
          />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('Pressure {level} · Swap {size}', {
              level: memory.pressure === null ? t('n/a') : levelLabel(memory.pressure),
              size: formatBytes(memory.swapUsedBytes),
            })}
          </p>
        </section>
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="flex items-center gap-2 font-medium">
              {t('Browsers')}
              <Level level={browsers.level} />
            </span>
            <span className="tabular-nums">
              {systemNumber(browsers.processes)} · {formatBytes(browsers.rssBytes)}
            </span>
          </div>
          <div
            role="meter"
            aria-label={t('Browsers')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={browsers.rssBytes > 0 ? 100 : 0}
            className="flex h-2.5 overflow-hidden rounded-sm bg-muted"
          >
            {browsers.rssBytes > 0 &&
              browserCategories.map(
                (category) =>
                  browsers.categories[category.key].rssBytes > 0 && (
                    <span
                      key={category.key}
                      className={category.color}
                      style={{ width: `${(browsers.categories[category.key].rssBytes / browsers.rssBytes) * 100}%` }}
                    />
                  ),
              )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
            {browserCategories.map((category) => (
              <div
                key={category.key}
                data-testid={`browser-${category.key}`}
                className="flex items-center gap-1.5 text-xs"
              >
                <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', category.color)} />
                <span className="min-w-0 text-muted-foreground">{t(category.label)}</span>
                <span className="ml-auto tabular-nums">
                  {systemNumber(browsers.categories[category.key].processes)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}
