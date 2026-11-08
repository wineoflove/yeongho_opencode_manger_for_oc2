import { useMemo, useState } from 'react'
import { t } from '@/i18n/translate'
import { ListFilter, Search, X } from 'lucide-react'
import type { TokenFilterDimension, TokenStatsFacetValue, TokenStatsFilter } from '@opencode-manager/shared/schemas'
import { Button } from '@/components/ui/button'
import { BottomSheet, BottomSheetContent, BottomSheetHeader } from '@/components/ui/bottom-sheet'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMobile } from '@/hooks/useMobile'
import { cn } from '@/lib/utils'
import { DIMENSION_LABELS, FILTER_MENU_DIMENSIONS, formatTokens } from '@/lib/tokenStats'

type Facets = Partial<Record<TokenFilterDimension, readonly TokenStatsFacetValue[]>>

interface StatsFilterBarProps {
  filters: readonly TokenStatsFilter[]
  facets: Facets
  onToggle: (filter: TokenStatsFilter) => void
  onClear: () => void
}

function isSelected(filters: readonly TokenStatsFilter[], dimension: TokenFilterDimension, key: string): boolean {
  return filters.some((filter) => filter.dimension === dimension && filter.value === key)
}

function DesktopFilterMenu({ filters, facets, onToggle }: Omit<StatsFilterBarProps, 'onClear'>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5">
          <ListFilter className="h-3.5 w-3.5" />
          {t('Filter')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {FILTER_MENU_DIMENSIONS.map((dimension) => {
          const values = facets[dimension] ?? []
          const selectedCount = filters.filter((filter) => filter.dimension === dimension).length
          return (
            <DropdownMenuSub key={dimension}>
              <DropdownMenuSubTrigger disabled={values.length === 0} className="gap-2">
                <span className="flex-1">{t(DIMENSION_LABELS[dimension])}</span>
                {selectedCount > 0 && (
                  <span className="rounded bg-primary/15 px-1.5 font-mono text-[10px] text-primary">
                    {selectedCount}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[60vh] w-80 overflow-y-auto">
                {values.map((value) => (
                  <DropdownMenuCheckboxItem
                    key={value.key}
                    checked={isSelected(filters, dimension, value.key)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={() => onToggle({ dimension, value: value.key })}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate" title={value.label}>
                      {value.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatTokens(value.total)}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MobileFilterSheet({ filters, facets, onToggle }: Omit<StatsFilterBarProps, 'onClear'>) {
  const [open, setOpen] = useState(false)
  const [dimension, setDimension] = useState<TokenFilterDimension>('model')
  const [search, setSearch] = useState('')
  const values = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (facets[dimension] ?? []).filter((value) => !needle || value.label.toLowerCase().includes(needle))
  }, [facets, dimension, search])

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => setOpen(true)}>
        <ListFilter className="h-3.5 w-3.5" />
        {t('Filter')}
      </Button>
      {open && (
        <BottomSheet
          isOpen
          onClose={() => setOpen(false)}
          heightClass="h-[75dvh]"
          ariaLabel={t('Filter token statistics')}
        >
          <BottomSheetHeader>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('Filter')}</h2>
              <Button size="sm" onClick={() => setOpen(false)}>
                {t('Done')}
              </Button>
            </div>
            <div
              className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none]"
              role="tablist"
              aria-label={t('Filter dimension')}
            >
              {FILTER_MENU_DIMENSIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={dimension === item}
                  onClick={() => {
                    setDimension(item)
                    setSearch('')
                  }}
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium',
                    dimension === item
                      ? 'border-foreground/30 bg-accent text-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {t(DIMENSION_LABELS[item])}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('Search {dimension}', { dimension: t(DIMENSION_LABELS[dimension]).toLowerCase() })}
                aria-label={t('Search {dimension}', { dimension: t(DIMENSION_LABELS[dimension]) })}
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-[16px] placeholder:text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </BottomSheetHeader>
          <BottomSheetContent className="overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+16px)]">
            {values.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t('No values in this range')}</p>
            ) : (
              values.map((value) => {
                const checked = isSelected(filters, dimension, value.key)
                return (
                  <label
                    key={value.key}
                    className="flex min-h-11 items-center gap-3 border-b border-border/60 py-2 text-sm last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle({ dimension, value: value.key })}
                      className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{value.label}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatTokens(value.total)}
                    </span>
                  </label>
                )
              })
            )}
          </BottomSheetContent>
        </BottomSheet>
      )}
    </>
  )
}

export function StatsFilterBar({ filters, facets, onToggle, onClear }: StatsFilterBarProps) {
  const isMobile = useMobile()
  const labelFor = (filter: TokenStatsFilter) =>
    facets[filter.dimension]?.find((value) => value.key === filter.value)?.label ?? filter.value

  return (
    <div className="flex min-w-0 items-center gap-2">
      {isMobile ? (
        <MobileFilterSheet filters={filters} facets={facets} onToggle={onToggle} />
      ) : (
        <DesktopFilterMenu filters={filters} facets={facets} onToggle={onToggle} />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {filters.length === 0 ? (
          <span className="truncate text-xs text-muted-foreground">
            {t('All usage · click a row below to drill down')}
          </span>
        ) : (
          filters.map((filter) => (
            <span
              key={`${filter.dimension}:${filter.value}`}
              className="flex h-7 max-w-64 shrink-0 items-center gap-1 rounded-full border border-border bg-card pl-2.5 pr-1 text-xs"
            >
              <span className="text-muted-foreground">{t(DIMENSION_LABELS[filter.dimension])}</span>
              <span className="min-w-0 truncate font-medium">{labelFor(filter)}</span>
              <button
                type="button"
                onClick={() => onToggle(filter)}
                aria-label={t('Remove {dimension} filter {value}', {
                  dimension: t(DIMENSION_LABELS[filter.dimension]),
                  value: labelFor(filter),
                })}
                className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      {filters.length > 0 && (
        <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={onClear}>
          {t('Clear')}
        </Button>
      )}
    </div>
  )
}
