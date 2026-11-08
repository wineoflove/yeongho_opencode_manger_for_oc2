import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, ChevronRight, Columns3, Layers, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { workspaceLabel, worktreeSourceLabel, type RepoSibling } from '@/api/repos'
import type { Session } from '@/api/types'
import type { MultiRun } from '@opencode-manager/shared/schemas'
import type { RepoWorktreeSource } from '@opencode-manager/shared/utils'
import { msg, t, tn } from '@/i18n/translate'

type OwnerFilter = 'all' | RepoWorktreeSource

interface WorktreeSessionGroupsProps {
  repoId: number
  worktrees: RepoSibling[]
  sessions: Session[]
  multiRuns?: MultiRun[]
  searchQuery: string
  renderSessionCard: (session: Session) => ReactNode
  onExpandedScheduleDirectoriesChange?: (directories: string[]) => void
  onNewSession: (directory: string) => void
  onOpenTerminal: (directory: string) => void
  onCreateWorktree: () => void
  onDelete: (directories: string[]) => void
  isDeleting?: boolean
}

interface WorktreeGroup {
  worktree: RepoSibling
  directory: string
  sessions: Session[]
  lastActive: number
}

type GroupEntry =
  | { kind: 'worktree'; key: string; group: WorktreeGroup; lastActive: number }
  | { kind: 'schedule'; key: string; jobId: number; name: string; groups: WorktreeGroup[]; lastActive: number }
  | { kind: 'multiRun'; key: string; runId: number; name: string; groups: WorktreeGroup[]; lastActive: number }

const OWNER_FILTERS: Array<{ value: OwnerFilter; label: string }> = [
  { value: 'all', label: msg('All') },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'schedule', label: msg('Schedules') },
  { value: 'git', label: 'Git' },
]

const OWNER_BADGE_CLASS: Record<RepoWorktreeSource, string> = {
  opencode: 'border-primary/40 bg-primary/15 text-primary',
  schedule: 'border-highlight/40 bg-highlight/15 text-highlight',
  git: 'border-border bg-muted text-muted-foreground',
}

const WORKTREE_REMOVAL_NOTE = msg('OpenCode worktrees are removed with their sessions. Schedule worktrees have pending changes committed to their branch first. Other git worktrees are only removed when they have no uncommitted changes.')

/**
 * The Worktrees tab body: every worktree of the repo as a collapsible section of its sessions,
 * with a schedule's worktrees nested under that schedule and a multi-run's worktrees nested under
 * that multi-run, so kept runs stay visible as they pile up.
 */
export function WorktreeSessionGroups({
  repoId,
  worktrees,
  sessions,
  multiRuns,
  searchQuery,
  renderSessionCard,
  onExpandedScheduleDirectoriesChange,
  onNewSession,
  onOpenTerminal,
  onCreateWorktree,
  onDelete,
  isDeleting = false,
}: WorktreeSessionGroupsProps) {
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all')
  const [collapsed, setCollapsed] = useCollapsedGroups(repoId)
  const [expandedSchedule, setExpandedSchedule] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<{ directories: string[]; label: string } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const isSearching = searchQuery.trim().length > 0

  const scheduleWorktreeDirectories = useMemo(
    () => worktrees.filter(isScheduleWorktree).map((worktree) => worktree.fullPath),
    [worktrees],
  )

  useEffect(() => {
    onExpandedScheduleDirectoriesChange?.(
      scheduleWorktreeDirectories.filter((directory) => expandedSchedule.has(directory)),
    )
  }, [expandedSchedule, scheduleWorktreeDirectories, onExpandedScheduleDirectoriesChange])

  const ownerCounts = useMemo(() => {
    const counts: Record<OwnerFilter, number> = { all: worktrees.length, opencode: 0, schedule: 0, git: 0 }
    worktrees.forEach((worktree) => {
      if (worktree.worktreeSource) counts[worktree.worktreeSource] += 1
    })
    return counts
  }, [worktrees])

  const entries = useMemo(
    () => buildGroupEntries(worktrees, sessions, ownerFilter, isSearching, multiRuns ?? []),
    [worktrees, sessions, ownerFilter, isSearching, multiRuns],
  )

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isGroupOpen = (group: WorktreeGroup) => (
    isScheduleWorktree(group.worktree)
      ? expandedSchedule.has(group.directory)
      : !collapsed.has(groupKey(group.directory))
  )

  const toggleGroup = (group: WorktreeGroup) => {
    if (isScheduleWorktree(group.worktree)) {
      setExpandedSchedule((current) => {
        const next = new Set(current)
        if (next.has(group.directory)) next.delete(group.directory)
        else next.add(group.directory)
        return next
      })
      return
    }
    toggle(groupKey(group.directory))
  }

  const selectableDirectories = entries
    .flatMap((entry) => (entry.kind === 'worktree' ? [entry.group] : entry.groups))
    .filter((group) => group.worktree.schedule?.inUse !== true)
    .map((group) => group.directory)
  const selectedDirectories = selectableDirectories.filter((directory) => selected.has(directory))
  const allSelectableSelected =
    selectableDirectories.length > 0 && selectedDirectories.length === selectableDirectories.length

  const toggleSelected = (directory: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelectableSelected ? new Set() : new Set(selectableDirectories))
  }

  const toggleSelecting = () => {
    setSelecting((current) => !current)
    setSelected(new Set())
  }

  const scheduleGroupDirectories = entries.flatMap((entry) => (
    entry.kind === 'schedule' ? entry.groups.map((group) => group.directory) : []
  ))
  const allCollapsed = entries.length > 0 && entries.every((entry) => {
    if (collapsed.has(entry.key)) return true
    if (entry.kind === 'schedule') return entry.groups.every((group) => !expandedSchedule.has(group.directory))
    return false
  })
  const toggleAll = () => {
    if (allCollapsed) {
      setCollapsed((current) => {
        const next = new Set(current)
        entries.forEach((entry) => next.delete(entry.key))
        return next
      })
      setExpandedSchedule(new Set(scheduleGroupDirectories))
      return
    }
    setCollapsed(new Set(entries.map((entry) => entry.key)))
    setExpandedSchedule(new Set())
  }

  if (worktrees.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-6 text-center">
        <p className="font-medium">{t('No worktrees yet')}</p>
        <p className="text-sm text-muted-foreground">{t('Create a worktree to work on a branch without touching the main checkout.')}</p>
        <Button size="sm" onClick={onCreateWorktree}>
          <Plus className="mr-1 h-4 w-4" />
          {t('New worktree')}
        </Button>
      </div>
    )
  }

  const renderWorktreeActions = (group: WorktreeGroup, label: string, compact: boolean) => {
    const isInUse = group.worktree.schedule?.inUse === true
    const buttonSize = compact ? 'size-7' : 'size-8'
    const iconSize = compact ? 'h-3.5 w-3.5' : 'h-4 w-4'
    if (selecting) {
      return (
        <span className={`${buttonSize} flex shrink-0 items-center justify-center`}>
          <Checkbox
            checked={selected.has(group.directory)}
            disabled={isInUse || isDeleting}
            onCheckedChange={() => toggleSelected(group.directory)}
            aria-label={t('Select worktree {name}', { name: label })}
            title={isInUse ? t('In use by a running scheduled run') : undefined}
          />
        </span>
      )
    }
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSize} shrink-0`}
          aria-label={t('New session in {name}', { name: label })}
          onClick={() => onNewSession(group.directory)}
        >
          <Plus className={iconSize} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSize} shrink-0`}
          aria-label={t('Open terminal in {name}', { name: label })}
          onClick={() => onOpenTerminal(group.directory)}
        >
          <SquareTerminal className={iconSize} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSize} shrink-0 text-muted-foreground hover:text-destructive`}
          aria-label={t('Delete worktree {name}', { name: label })}
          title={isInUse ? t('In use by a running scheduled run') : undefined}
          disabled={isInUse || isDeleting}
          onClick={() => setPendingDelete({ directories: [group.directory], label })}
        >
          <Trash2 className={iconSize} />
        </Button>
      </>
    )
  }

  const renderSessions = (group: WorktreeGroup, label: string) => (
    group.sessions.length > 0 ? group.sessions.map(renderSessionCard) : (
      <button
        type="button"
        onClick={() => onNewSession(group.directory)}
        className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        {t('No sessions in {label} · Start one', { label })}
      </button>
    )
  )

  const renderWorktree = (group: WorktreeGroup, nested: boolean) => {
    const key = groupKey(group.directory)
    const isOpen = isGroupOpen(group)
    const label = workspaceLabel(group.worktree)
    const source = group.worktree.worktreeSource
    const sourceLabel = worktreeSourceLabel(group.worktree)
    const isInUse = group.worktree.schedule?.inUse === true
    return (
      <div key={key} className={`rounded-md border border-border bg-card/40 ${nested ? 'ml-3' : ''}`}>
        <div className="flex items-center gap-1 px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggleGroup(group)}
            aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
          >
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{label}</span>
                {sourceLabel && source && (
                  <span className={`shrink-0 rounded-none border px-1.5 text-[10px] leading-4 ${OWNER_BADGE_CLASS[source]}`}>{sourceLabel}</span>
                )}
                {isInUse && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/15 px-1.5 text-[10px] leading-4 text-success">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                    {t('in use')}
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {tn('{count} session', '{count} sessions', group.sessions.length)}
                </span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground" title={group.directory}>{group.directory}</div>
            </div>
          </button>
          {renderWorktreeActions(group, label, false)}
        </div>
        {isOpen && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            {renderSessions(group, label)}
          </div>
        )}
      </div>
    )
  }

  const renderMultiRunWorktree = (group: WorktreeGroup) => {
    const label = workspaceLabel(group.worktree)
    return (
      <div key={groupKey(group.directory)} className="py-2">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground" title={group.directory}>{label}</span>
          {group.sessions.length > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">· {tn('{count} session', '{count} sessions', group.sessions.length)}</span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {renderWorktreeActions(group, label, true)}
          </div>
        </div>
        <div className="mt-1.5 flex flex-col gap-2">
          {renderSessions(group, label)}
        </div>
      </div>
    )
  }

  const renderMultiRunEntry = (entry: Extract<GroupEntry, { kind: 'multiRun' }>) => {
    const isOpen = !collapsed.has(entry.key)
    const removable = entry.groups.map((group) => group.directory)
    return (
      <div key={entry.key} className="rounded-md border border-border bg-card/40">
        <div className="flex items-center gap-1 px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggle(entry.key)}
            aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
          >
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <Columns3 className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-medium">{entry.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {tn('{count} worktree', '{count} worktrees', entry.groups.length)}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-xs text-muted-foreground hover:text-destructive"
            disabled={removable.length === 0 || isDeleting}
            onClick={() => setPendingDelete({ directories: removable, label: t('{name} worktrees', { name: entry.name }) })}
          >
            {t('Clean up')}
          </Button>
        </div>
        {isOpen && (
          <div className="divide-y divide-border px-3 pb-3">
            {entry.groups.map(renderMultiRunWorktree)}
          </div>
        )}
      </div>
    )
  }

  const renderScheduleEntry = (entry: Extract<GroupEntry, { kind: 'schedule' }>) => {
    const isOpen = !collapsed.has(entry.key)
    const removable = worktrees
      .filter((worktree) => worktree.schedule?.jobId === entry.jobId && !worktree.schedule.inUse)
      .map((worktree) => worktree.fullPath)
    return (
      <div key={entry.key} className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => toggle(entry.key)}
            aria-expanded={isOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-accent/50"
          >
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <CalendarClock className="h-4 w-4 shrink-0 text-highlight" />
            <span className="truncate font-medium">{entry.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              · {tn('{count} worktree', '{count} worktrees', entry.groups.length)}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-xs text-muted-foreground hover:text-destructive"
            disabled={removable.length === 0 || isDeleting}
            onClick={() => setPendingDelete({ directories: removable, label: t('{name} worktrees', { name: entry.name }) })}
          >
            {t('Clean up')}
          </Button>
        </div>
        {isOpen && entry.groups.map((group) => renderWorktree(group, true))}
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {OWNER_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={ownerFilter === filter.value}
            onClick={() => setOwnerFilter(filter.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${ownerFilter === filter.value
              ? 'border-primary/50 bg-primary/15 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground'}`}
          >
            {t(filter.label)} {ownerCounts[filter.value]}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {selecting && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={toggleSelectAll}
                disabled={selectableDirectories.length === 0 || isDeleting}
              >
                {allSelectableSelected ? t('Clear selection') : t('Select all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-destructive hover:text-destructive"
                disabled={selectedDirectories.length === 0 || isDeleting}
                onClick={() =>
                  setPendingDelete({
                    directories: selectedDirectories,
                    label: t('{count} selected', { count: selectedDirectories.length }),
                  })
                }
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {t('Delete selected')}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            aria-pressed={selecting}
            onClick={toggleSelecting}
          >
            {selecting ? t('Done') : t('Manage worktrees')}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={toggleAll}>
            {allCollapsed ? t('Expand all') : t('Collapse all')}
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onCreateWorktree}>
            <Layers className="mr-1 h-3.5 w-3.5 text-primary" />
            {t('New worktree')}
          </Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted-foreground">
          {isSearching ? t('No sessions found') : t('No worktrees match this filter')}
        </div>
      ) : entries.map((entry) => {
        if (entry.kind === 'worktree') return renderWorktree(entry.group, false)
        if (entry.kind === 'multiRun') return renderMultiRunEntry(entry)
        return renderScheduleEntry(entry)
      })}

      <DeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            const removable = new Set(
              worktrees.filter((worktree) => worktree.schedule?.inUse !== true).map((worktree) => worktree.fullPath),
            )
            const directories = pendingDelete.directories.filter((directory) => removable.has(directory))
            if (directories.length > 0) onDelete(directories)
            setSelected((current) => {
              const next = new Set(current)
              pendingDelete.directories.forEach((directory) => next.delete(directory))
              return next
            })
          }
          setPendingDelete(null)
        }}
        title={pendingDelete && pendingDelete.directories.length > 1 ? t('Delete Worktrees') : t('Delete Worktree')}
        description={pendingDelete && pendingDelete.directories.length > 1
          ? `${t('Delete {count} worktrees?', { count: pendingDelete.directories.length })} ${t(WORKTREE_REMOVAL_NOTE)}`
          : `${t('Delete this worktree?')} ${t(WORKTREE_REMOVAL_NOTE)}`}
        itemName={pendingDelete?.label}
        isDeleting={isDeleting}
      />
    </>
  )
}

function groupKey(directory: string): string {
  return `worktree:${directory}`
}

function isScheduleWorktree(worktree: RepoSibling): boolean {
  return worktree.worktreeSource === 'schedule'
}

function buildGroupEntries(
  worktrees: RepoSibling[],
  sessions: Session[],
  ownerFilter: OwnerFilter,
  hideEmpty: boolean,
  multiRuns: MultiRun[],
): GroupEntry[] {
  const sessionsByDirectory = new Map<string, Session[]>()
  sessions.forEach((session) => {
    const list = sessionsByDirectory.get(session.location.directory) ?? []
    list.push(session)
    sessionsByDirectory.set(session.location.directory, list)
  })

  const multiRunByDirectory = new Map<string, { id: number; name: string }>()
  multiRuns.forEach((run) => {
    run.entries.forEach((entry) => {
      if (entry.directory) multiRunByDirectory.set(entry.directory, { id: run.id, name: run.name })
    })
    run.fusions.forEach((fusion) => {
      if (fusion.directory) multiRunByDirectory.set(fusion.directory, { id: run.id, name: run.name })
    })
  })

  const groups = worktrees
    .filter((worktree) => ownerFilter === 'all' || worktree.worktreeSource === ownerFilter)
    .map((worktree): WorktreeGroup => {
      const groupSessions = sessionsByDirectory.get(worktree.fullPath) ?? []
      return {
        worktree,
        directory: worktree.fullPath,
        sessions: groupSessions,
        lastActive: groupSessions[0]?.time.updated ?? 0,
      }
    })
    .filter((group) => !hideEmpty || group.sessions.length > 0)

  const scheduleEntries = new Map<number, Extract<GroupEntry, { kind: 'schedule' }>>()
  const multiRunEntries = new Map<number, Extract<GroupEntry, { kind: 'multiRun' }>>()
  const entries: GroupEntry[] = []
  groups.forEach((group) => {
    const schedule = group.worktree.schedule
    if (schedule) {
      const existing = scheduleEntries.get(schedule.jobId)
      if (existing) {
        existing.groups.push(group)
        existing.lastActive = Math.max(existing.lastActive, group.lastActive)
        return
      }
      const entry: Extract<GroupEntry, { kind: 'schedule' }> = {
        kind: 'schedule',
        key: `schedule:${schedule.jobId}`,
        jobId: schedule.jobId,
        name: schedule.name,
        groups: [group],
        lastActive: group.lastActive,
      }
      scheduleEntries.set(schedule.jobId, entry)
      entries.push(entry)
      return
    }
    const multiRun = multiRunByDirectory.get(group.directory)
    if (multiRun) {
      const existing = multiRunEntries.get(multiRun.id)
      if (existing) {
        existing.groups.push(group)
        existing.lastActive = Math.max(existing.lastActive, group.lastActive)
        return
      }
      const entry: Extract<GroupEntry, { kind: 'multiRun' }> = {
        kind: 'multiRun',
        key: `multi-run:${multiRun.id}`,
        runId: multiRun.id,
        name: multiRun.name,
        groups: [group],
        lastActive: group.lastActive,
      }
      multiRunEntries.set(multiRun.id, entry)
      entries.push(entry)
      return
    }
    entries.push({ kind: 'worktree', key: groupKey(group.directory), group, lastActive: group.lastActive })
  })

  scheduleEntries.forEach((entry) => entry.groups.sort((a, b) => b.lastActive - a.lastActive))
  multiRunEntries.forEach((entry) => entry.groups.sort((a, b) => b.lastActive - a.lastActive))
  return entries.sort((a, b) => b.lastActive - a.lastActive)
}

function useCollapsedGroups(repoId: number) {
  const storageKey = `oc:repo:${repoId}:worktree-groups:collapsed`
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(storageKey))

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(collapsed)))
    } catch {
      return
    }
  }, [storageKey, collapsed])

  return [collapsed, setCollapsed] as const
}

function readCollapsed(storageKey: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}
