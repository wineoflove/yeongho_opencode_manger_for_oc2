import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { t } from '@/i18n/translate'
import type { TokenSplit, TokenStatsBucket } from '@opencode-manager/shared/schemas'
import {
  apiCost,
  formatBucketLabel,
  formatBucketTitle,
  formatCost,
  formatCostSplit,
  formatTokens,
  niceCeiling,
  seriesColor,
} from '@/lib/tokenStats'

interface TokenStatsChartProps {
  buckets: readonly TokenStatsBucket[]
  series: readonly { key: string; label: string }[]
  interval: 'hour' | 'day'
  splitBy: TokenSplit
  height?: number
  formatValue?: (value: number) => string
}

const PADDING = { top: 10, right: 4, bottom: 22, left: 48 }
const GRID_LINES = 4
const MIN_LABEL_SPACING = 52

export function TokenStatsChart({
  buckets,
  series,
  interval,
  splitBy,
  height = 240,
  formatValue = formatTokens,
}: TokenStatsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const colors = useMemo(() => series.map((item, index) => seriesColor(item.key, index, splitBy)), [series, splitBy])
  const max = niceCeiling(Math.max(0, ...buckets.map((bucket) => bucket.values.reduce((sum, value) => sum + value, 0))))
  const plotWidth = Math.max(0, width - PADDING.left - PADDING.right)
  const plotHeight = height - PADDING.top - PADDING.bottom
  const slot = buckets.length > 0 ? plotWidth / buckets.length : 0
  const barWidth = Math.max(1, Math.min(28, slot * 0.68))
  const labelStep = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotWidth / MIN_LABEL_SPACING))))
  const y = (value: number) => PADDING.top + plotHeight - (value / max) * plotHeight
  const hasData = buckets.some((bucket) => bucket.total > 0)

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - rect.left - PADDING.left) / slot)
    setActive(index >= 0 && index < buckets.length ? index : null)
  }

  const activeBucket = active === null ? undefined : buckets[active]
  const tooltipLeft =
    active === null ? 0 : Math.min(Math.max(PADDING.left + slot * (active + 0.5) - 100, 0), Math.max(0, width - 200))
  const peak = buckets.reduce<TokenStatsBucket | undefined>(
    (best, bucket) => (!best || bucket.total > best.total ? bucket : best),
    undefined,
  )

  return (
    <div ref={containerRef} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={
            hasData && peak
              ? t('Token usage per {interval}. Peak {total} on {date}.', {
                  interval: t(interval),
                  total: formatValue(peak.total),
                  date: formatBucketTitle(peak.start, interval),
                })
              : t('No token usage in this range')
          }
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setActive(null)
          }}
          className="touch-pan-y"
        >
          {Array.from({ length: GRID_LINES + 1 }, (_, index) => {
            const value = (max / GRID_LINES) * index
            const lineY = y(value)
            return (
              <g key={index}>
                <line
                  x1={PADDING.left}
                  x2={width - PADDING.right}
                  y1={lineY}
                  y2={lineY}
                  stroke="var(--color-border)"
                  strokeOpacity={index === 0 ? 1 : 0.45}
                  strokeDasharray={index === 0 ? undefined : '2 4'}
                />
                <text
                  x={PADDING.left - 8}
                  y={lineY}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground font-mono text-[10px]"
                >
                  {hasData ? formatValue(value) : index === 0 ? '0' : ''}
                </text>
              </g>
            )
          })}
          {buckets.map((bucket, bucketIndex) => {
            const x = PADDING.left + slot * bucketIndex + (slot - barWidth) / 2
            let offset = 0
            const dimmed = active !== null && active !== bucketIndex
            return (
              <g key={bucket.start} opacity={dimmed ? 0.4 : 1}>
                {bucket.values.map((value, seriesIndex) => {
                  if (value <= 0) return null
                  const top = y(offset + value)
                  const segmentHeight = Math.max(0.5, y(offset) - top)
                  offset += value
                  return (
                    <rect
                      key={seriesIndex}
                      x={x}
                      y={top}
                      width={barWidth}
                      height={segmentHeight}
                      fill={colors[seriesIndex]}
                      rx={barWidth > 6 ? 1.5 : 0}
                    />
                  )
                })}
                {bucketIndex % labelStep === 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground font-mono text-[10px]"
                  >
                    {formatBucketLabel(bucket.start, interval)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {!hasData && width > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {t('No token usage in this range')}
        </div>
      )}
      {activeBucket && activeBucket.total > 0 && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 w-[200px] rounded-lg border border-border bg-popover/95 p-2.5 text-xs shadow-lg backdrop-blur-sm"
          style={{ left: tooltipLeft }}
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 font-mono text-[11px] text-muted-foreground">
            <span>{formatBucketTitle(activeBucket.start, interval)}</span>
            <span title={formatCostSplit(activeBucket)}>
              <span className="sr-only">{t('API-equivalent cost')} </span>
              {formatCost(apiCost(activeBucket))}
            </span>
          </div>
          {activeBucket.estimatedCost > 0 && (
            <p className="mb-1.5 text-[11px] text-muted-foreground">{formatCostSplit(activeBucket)}</p>
          )}
          <div className="flex flex-col gap-1">
            {series.map((item, index) => {
              const value = activeBucket.values[index] ?? 0
              if (value <= 0) return null
              return (
                <div key={item.key} className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colors[index] }} />
                  <span className="min-w-0 flex-1 truncate">
                    {splitBy === 'tokenType' || item.key === '__other' ? t(item.label) : item.label}
                  </span>
                  <span className="font-mono tabular-nums">{formatValue(value)}</span>
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 flex justify-between border-t border-border pt-1.5 font-medium">
            <span>{t('Total')}</span>
            <span className="font-mono tabular-nums">{formatValue(activeBucket.total)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
