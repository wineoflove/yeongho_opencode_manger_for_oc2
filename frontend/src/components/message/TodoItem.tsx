import { CheckCircle2, Circle, CircleSlash } from 'lucide-react'
import type { SessionTodo } from '@/lib/sessionTodos'
import { cn } from '@/lib/utils'
import { msg, t } from '@/i18n/translate'

const STATUS_LABELS: Record<SessionTodo['status'], string> = {
  pending: msg('Pending'),
  in_progress: msg('In Progress'),
  completed: msg('Completed'),
  cancelled: msg('Cancelled'),
}

interface TodoItemProps {
  todo: SessionTodo
  compact?: boolean
}

/** One todo with a status icon: done, spinning while in progress, struck for cancelled, open otherwise. */
export function TodoItem({ todo, compact = false }: TodoItemProps) {
  const iconClass = compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
  const icon =
    todo.status === 'completed' ? (
      <CheckCircle2 aria-hidden="true" className={cn(iconClass, 'shrink-0 text-success')} />
    ) : todo.status === 'in_progress' ? (
      <span
        aria-hidden="true"
        className={cn(
          iconClass,
          'shrink-0 animate-spin rounded-full border-2 border-warning border-t-transparent motion-reduce:animate-none',
        )}
      />
    ) : todo.status === 'cancelled' ? (
      <CircleSlash aria-hidden="true" className={cn(iconClass, 'shrink-0 text-muted-foreground')} />
    ) : (
      <Circle aria-hidden="true" className={cn(iconClass, 'shrink-0 text-muted-foreground')} />
    )

  return (
    <div className={cn('flex items-center gap-1.5 pl-0.5', compact ? 'py-0.5 text-xs' : 'py-1 text-sm')}>
      {icon}
      <span className="sr-only">{t(STATUS_LABELS[todo.status])}: </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          todo.status === 'in_progress' && 'font-medium text-warning',
          (todo.status === 'completed' || todo.status === 'cancelled') &&
            'text-muted-foreground line-through opacity-60',
          todo.status === 'pending' && 'text-foreground',
        )}
      >
        {todo.content}
      </span>
    </div>
  )
}
