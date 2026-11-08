import { describe, expect, it } from 'vitest'
import type { SessionMessageAssistant, SessionMessageAssistantTool } from '@opencode-manager/shared/opencode'
import { afterEach } from 'vitest'
import { explorationElapsedMs, explorationFailureCount, explorationLabel, groupExplorationParts } from './explorationGroups'
import { setLocale } from '@/i18n/locale'

const tool = (id: string, name: string, status: 'completed' | 'running' = 'completed'): SessionMessageAssistantTool =>
  status === 'completed'
    ? { type: 'tool', id, name, state: { status, input: {}, content: [], metadata: {} }, time: { created: 0, ran: 0, completed: 1 } }
    : { type: 'tool', id, name, state: { status, input: {} }, time: { created: 0, ran: 0 } }

const failedTool = (id: string, name: string): SessionMessageAssistantTool => ({
  type: 'tool',
  id,
  name,
  state: { status: 'error', input: {}, error: { type: 'tool.failed', message: 'File not found' }, metadata: {} },
  time: { created: 0, ran: 1, completed: 2 },
})

const text = (value: string): SessionMessageAssistant['content'][number] => ({ type: 'text', text: value })
const reasoning = (value: string): SessionMessageAssistant['content'][number] => ({ type: 'reasoning', text: value })

describe('groupExplorationParts', () => {
  it('collapses consecutive tool calls, including commands and edits, and breaks runs on visible text', () => {
    const items = groupExplorationParts(
      [tool('a', 'read'), tool('b', 'grep'), text('found it'), tool('c', 'read'), tool('d', 'shell'), tool('e', 'edit')],
      false,
    )
    expect(items.map((item) => (item.type === 'exploration' ? item.parts.map((part) => part.id) : item.part.type))).toEqual([
      ['a', 'b'],
      'text',
      ['c', 'd', 'e'],
    ])
  })

  it('keeps a lone command or edit inline but groups a lone exploration call', () => {
    const items = groupExplorationParts([tool('a', 'shell'), text('then'), tool('b', 'read'), text('and'), tool('c', 'write')], false)
    expect(items.map((item) => (item.type === 'exploration' ? 'group' : item.part.type))).toEqual([
      'tool',
      'text',
      'group',
      'text',
      'tool',
    ])
  })

  it('never groups subagent or other tools outside the activity set', () => {
    const items = groupExplorationParts([tool('a', 'read'), tool('b', 'subagent'), tool('c', 'read')], false)
    expect(items.map((item) => item.type)).toEqual(['exploration', 'part', 'exploration'])
  })

  it('does not let hidden reasoning or blank text split a run', () => {
    const items = groupExplorationParts([tool('a', 'read'), reasoning('thinking'), text('  '), tool('b', 'read')], false)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'exploration' })
  })

  it('lets visible reasoning split a run', () => {
    expect(groupExplorationParts([tool('a', 'read'), reasoning('thinking'), tool('b', 'read')], true)).toHaveLength(3)
  })
})

describe('explorationLabel', () => {
  it('counts tools with TUI nouns and pluralization', () => {
    expect(explorationLabel([tool('a', 'read'), tool('b', 'read'), tool('c', 'grep'), tool('d', 'glob'), tool('e', 'webfetch')]))
      .toBe('Explored: 2 reads, 2 searches, 1 fetch')
  })

  it('reports in-progress groups as exploring', () => {
    expect(explorationLabel([tool('a', 'read'), tool('b', 'read', 'running')])).toBe('Exploring: 2 reads')
  })

  it('surfaces failed members in the summary', () => {
    expect(explorationLabel([tool('a', 'read'), failedTool('b', 'read')])).toBe('Explored: 2 reads, 1 failed')
  })

  it('counts every failed member', () => {
    expect(explorationLabel([failedTool('a', 'read'), failedTool('b', 'grep'), tool('c', 'glob')]))
      .toBe('Explored: 1 read, 2 searches, 2 failed')
  })

  it('does not report failures for a group without errors', () => {
    expect(explorationLabel([tool('a', 'read')])).toBe('Explored: 1 read')
  })
})

describe('explorationFailureCount', () => {
  it('counts only errored members', () => {
    expect(explorationFailureCount([tool('a', 'read'), failedTool('b', 'read'), failedTool('c', 'glob')])).toBe(2)
    expect(explorationFailureCount([tool('a', 'read')])).toBe(0)
  })
})

describe('mixed activity labels', () => {
  afterEach(() => {
    setLocale('en')
  })

  it('labels runs that include commands or edits as work with per-category counts', () => {
    expect(explorationLabel([tool('a', 'read'), tool('b', 'shell'), tool('c', 'edit'), tool('d', 'write')])).toBe(
      'Worked: 1 read, 1 command, 2 edits',
    )
    expect(explorationLabel([tool('a', 'shell'), tool('b', 'shell', 'running')])).toBe('Working: 2 commands')
  })

  it('localizes headings and category counts in Korean', () => {
    setLocale('ko')
    expect(explorationLabel([tool('a', 'read'), tool('b', 'read'), tool('c', 'grep')])).toBe('탐색함: 읽기 2, 검색 1')
    expect(explorationLabel([tool('a', 'shell'), tool('b', 'edit', 'running')])).toBe('작업 중: 명령 1, 수정 1')
  })
})

describe('explorationElapsedMs', () => {
  it('spans first creation to last completion, or to now while a call is open', () => {
    const first = { ...tool('a', 'read'), time: { created: 1_000, ran: 1_000, completed: 3_000 } }
    const second = { ...tool('b', 'shell'), time: { created: 2_000, ran: 2_000, completed: 9_000 } }
    expect(explorationElapsedMs([first, second], 50_000)).toBe(8_000)
    const open = { ...tool('c', 'shell', 'running'), time: { created: 4_000, ran: 4_000 } }
    expect(explorationElapsedMs([first, open], 10_000)).toBe(9_000)
  })
})
