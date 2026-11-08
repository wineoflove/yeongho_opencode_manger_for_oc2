import { describe, expect, it } from 'vitest'
import type { SessionMessageInfo } from '@opencode-manager/shared/opencode'
import recorded from '@/test/opencode2TodoMessages.json'
import { getTodoProgress, latestSessionTodos } from './sessionTodos'

const messages = recorded as unknown as SessionMessageInfo[]

describe('latestSessionTodos', () => {
  it('reads the latest completed todowrite input recorded by OpenCode 2.2.5', () => {
    expect(latestSessionTodos(messages)).toEqual([
      { content: 'Read the failing test', status: 'completed' },
      { content: 'Fix the parser', status: 'completed' },
      { content: 'Run the suite', status: 'in_progress' },
      { content: 'Drop the workaround', status: 'cancelled' },
    ])
  })

  it('ignores a running or malformed todowrite call and falls back to the previous list', () => {
    const latest = messages.findLast((message) => message.type === 'assistant')
    if (latest?.type !== 'assistant') throw new Error('fixture lacks an assistant message')
    const extra: SessionMessageInfo[] = [
      {
        ...latest,
        id: 'msg_running',
        content: [
          {
            type: 'tool',
            id: 'part_running',
            name: 'todowrite',
            state: { status: 'running', input: { todos: [] }, metadata: {} },
            time: { created: 1 },
          },
        ],
      },
      {
        ...latest,
        id: 'msg_bad',
        content: [
          {
            type: 'tool',
            id: 'part_bad',
            name: 'todowrite',
            state: {
              status: 'completed',
              input: { todos: [{ content: 'x', status: 'unknown' }] },
              content: [{ type: 'text', text: 'x' }],
            },
            time: { created: 1 },
          },
        ],
      },
    ] as unknown as SessionMessageInfo[]

    expect(latestSessionTodos([...messages, ...extra]).map((todo) => todo.content)).toContain('Drop the workaround')
    expect(latestSessionTodos([])).toEqual([])
  })
})

describe('getTodoProgress', () => {
  it('counts completed against non-cancelled todos', () => {
    expect(getTodoProgress(latestSessionTodos(messages))).toEqual({ completed: 2, total: 3, percent: 67 })
    expect(getTodoProgress([{ content: 'x', status: 'cancelled' }])).toBeNull()
  })
})
