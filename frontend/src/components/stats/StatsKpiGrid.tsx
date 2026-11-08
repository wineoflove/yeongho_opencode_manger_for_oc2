import { cn } from '@/lib/utils'
import type { KpiCardData } from '@/lib/statsKpis'

const CHART_HEIGHT = 32

export function Sparkline({ points, className }: { points: readonly number[]; className?: string }) {
  if (points.length === 0) return <div aria-hidden className={cn('h-9', className)} />
  const values = points.length === 1 ? [points[0] ?? 0, points[0] ?? 0] : points
  const max = Math.max(...values)
  const scale = max > 0 ? max : 1
  const step = 100 / (values.length - 1)
  const coordinates = values.map(
    (value, index) => [index * step, CHART_HEIGHT - 2 - (value / scale) * (CHART_HEIGHT - 4)] as const,
  )
  const line = coordinates.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  return (
    <svg
      aria-hidden
      viewBox={`0 0 100 ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      className={cn('h-9 w-full text-[var(--color-chart-1)]', className)}
      data-testid="kpi-sparkline"
    >
      <path d={`${line} L100 ${CHART_HEIGHT} L0 ${CHART_HEIGHT} Z`} fill="currentColor" fillOpacity={0.16} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function KpiCard({ card }: { card: KpiCardData }) {
  return (
    <article
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card px-3 pb-2 pt-3"
      data-testid="kpi-card"
      aria-label={card.label}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h3 className="truncate text-[11px] font-medium text-muted-foreground">{card.label}</h3>
        {card.delta && (
          <span
            className={cn(
              'shrink-0 font-mono text-[10px] tabular-nums',
              card.delta.direction === 'up' && 'text-warning',
              card.delta.direction === 'down' && 'text-success',
              card.delta.direction === 'flat' && 'text-muted-foreground',
            )}
          >
            {card.delta.text}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate font-mono text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">
        {card.value}
      </p>
      <p
        className="mt-1 truncate font-mono text-[11px] tabular-nums text-muted-foreground"
        title={card.title ?? card.detail}
      >
        {card.detail}
      </p>
      <Sparkline points={card.points} className="mt-2" />
    </article>
  )
}

export function StatsKpiGrid({ cards }: { cards: readonly KpiCardData[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <KpiCard key={card.key} card={card} />
      ))}
    </div>
  )
}
