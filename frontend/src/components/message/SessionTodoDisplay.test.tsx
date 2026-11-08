import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionTodoDisplay } from './SessionTodoDisplay'
import type { SessionTodo } from '@/lib/sessionTodos'

const todos: SessionTodo[] = [
  { content: 'Read the failing test', status: 'completed' },
  { content: 'Fix the parser', status: 'in_progress' },
  { content: 'Run the suite', status: 'pending' },
  { content: 'Drop the workaround', status: 'cancelled' },
]

describe('SessionTodoDisplay', () => {
  it('shows collapsed progress, expands into status groups, and omits cancelled todos', () => {
    render(<SessionTodoDisplay todos={todos} />)

    const toggle = screen.getByRole('button', { name: /Tasks: 1\/3 complete/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('progressbar', { name: 'Tasks' })).toHaveAttribute('aria-valuenow', '33')
    expect(screen.queryByTestId('todo-expanded-list')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    const list = screen.getByTestId('todo-expanded-list')
    expect(list).toHaveTextContent('In Progress (1)')
    expect(list).toHaveTextContent('Fix the parser')
    expect(list).not.toHaveTextContent('Drop the workaround')
  })

  it('stays dismissed until the list changes and hides once everything is done', () => {
    const { rerender } = render(<SessionTodoDisplay todos={todos} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tasks' }))
    expect(screen.queryByTestId('session-todo-display')).not.toBeInTheDocument()

    rerender(<SessionTodoDisplay todos={[...todos]} />)
    expect(screen.queryByTestId('session-todo-display')).not.toBeInTheDocument()

    const advanced = todos.map((todo) =>
      todo.content === 'Fix the parser' ? { ...todo, status: 'completed' as const } : todo,
    )
    rerender(<SessionTodoDisplay todos={advanced} />)
    expect(screen.getByRole('button', { name: /Tasks: 2\/3 complete/ })).toBeInTheDocument()

    rerender(
      <SessionTodoDisplay
        todos={advanced.map((todo) => ({ ...todo, status: todo.status === 'cancelled' ? 'cancelled' : 'completed' }))}
      />,
    )
    expect(screen.queryByTestId('session-todo-display')).not.toBeInTheDocument()
  })

  it('renders nothing without todos', () => {
    render(<SessionTodoDisplay todos={[]} />)
    expect(screen.queryByTestId('session-todo-display')).not.toBeInTheDocument()
  })
})
