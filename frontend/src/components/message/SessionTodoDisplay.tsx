import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { TodoItem } from './TodoItem'
import { getTodoProgress, type SessionTodo } from '@/lib/sessionTodos'
import { t } from '@/i18n/translate'

interface SessionTodoDisplayProps {
  todos: SessionTodo[]
}

const todoSignature = (todos: readonly SessionTodo[]) =>
  JSON.stringify(todos.map(({ content, status }) => [content, status]))

/**
 * Collapsible progress of the session's current todo list above the composer. It hides once every
 * countable todo is done, and a dismissal lasts until the list changes.
 */
export function SessionTodoDisplay({ todos }: SessionTodoDisplayProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  const signature = useMemo(() => todoSignature(todos), [todos])
  const progress = getTodoProgress(todos)
  const groups = useMemo(
    () => [
      { label: t('In Progress'), items: todos.filter((todo) => todo.status === 'in_progress') },
      { label: t('Pending'), items: todos.filter((todo) => todo.status === 'pending') },
      { label: t('Completed'), items: todos.filter((todo) => todo.status === 'completed') },
    ],
    [todos],
  )

  if (!progress || progress.completed === progress.total || dismissedSignature === signature) {
    return null
  }

  const visibleGroups = groups.filter((group) => group.items.length > 0)
  const summary = t('Tasks: {completed}/{total} complete', { completed: progress.completed, total: progress.total })

  return (
    <div className="mb-2 overflow-hidden rounded-lg" data-testid="session-todo-display">
      <div className="flex items-center gap-2 bg-muted/50 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="flex shrink-0 items-center gap-2 text-left"
        >
          {collapsed ? (
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 text-sm text-muted-foreground">{summary}</span>
        </button>
        <span
          role="progressbar"
          aria-label={t('Tasks')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
        >
          <span
            className="block h-full bg-success transition-all duration-300"
            style={{ width: `${progress.percent}%` }}
          />
        </span>
        <button
          type="button"
          onClick={() => setDismissedSignature(signature)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t('Dismiss tasks')}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      {!collapsed && (
        <div
          data-testid="todo-expanded-list"
          className="max-h-[80px] overflow-y-auto bg-muted/30 p-1.5 sm:max-h-[160px] sm:p-2"
        >
          {visibleGroups.map((group) => (
            <div key={group.label} className="mb-1 last:mb-0">
              {visibleGroups.length > 1 && (
                <div className="mb-0.5 ml-4 text-[9px] font-medium uppercase tracking-wider text-muted-foreground opacity-70">
                  {group.label} ({group.items.length})
                </div>
              )}
              {group.items.map((todo, index) => (
                <TodoItem key={`${index}:${todo.content}`} todo={todo} compact />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
