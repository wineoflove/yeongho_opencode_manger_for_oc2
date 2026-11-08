import type { SessionMessageAssistant, SessionMessageAssistantTool } from '@opencode-manager/shared/opencode'
import { t, tn } from '@/i18n/translate'

type AssistantContentPart = SessionMessageAssistant['content'][number]

export type AssistantContentItem =
  | { type: 'part'; part: AssistantContentPart }
  | { type: 'exploration'; parts: SessionMessageAssistantTool[] }

const EXPLORATION_TOOLS = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch'])
const WORK_TOOLS = new Set(['shell', 'bash', 'edit', 'write', 'patch', 'apply_patch'])

function isExplorationTool(part: AssistantContentPart): part is SessionMessageAssistantTool {
  return part.type === 'tool' && EXPLORATION_TOOLS.has(part.name.toLowerCase())
}

function isGroupableTool(part: AssistantContentPart): part is SessionMessageAssistantTool {
  return part.type === 'tool' && (EXPLORATION_TOOLS.has(part.name.toLowerCase()) || WORK_TOOLS.has(part.name.toLowerCase()))
}

function isInvisiblePart(part: AssistantContentPart, showReasoning: boolean): boolean {
  if (part.type === 'text') return part.text.trim().length === 0
  if (part.type === 'reasoning') return !showReasoning || part.text.trim().length === 0
  return false
}

/**
 * Collapses consecutive tool calls into groups, matching the OpenCode TUI for read, search, and fetch
 * runs and extending it to edits and shell commands. A run of exploration tools always groups; a run
 * that includes edits or commands groups only with at least two calls, so a lone command stays inline.
 * Parts that render nothing are dropped so they do not split a run.
 */
export function groupExplorationParts(
  content: SessionMessageAssistant['content'],
  showReasoning: boolean,
): AssistantContentItem[] {
  const items = content.reduce<AssistantContentItem[]>((result, part) => {
    if (isInvisiblePart(part, showReasoning)) return result
    const previous = result.at(-1)
    if (!isGroupableTool(part)) result.push({ type: 'part', part })
    else if (previous?.type === 'exploration') previous.parts.push(part)
    else result.push({ type: 'exploration', parts: [part] })
    return result
  }, [])
  return items.map((item) =>
    item.type === 'exploration' && item.parts.length === 1 && !isExplorationTool(item.parts[0])
      ? { type: 'part', part: item.parts[0] }
      : item,
  )
}

/** Whether every tool in an exploration group has finished, successfully or not. */
export function isExplorationComplete(parts: SessionMessageAssistantTool[]): boolean {
  return parts.every((part) => part.state.status === 'completed' || part.state.status === 'error')
}

/** Number of exploration tools that ended in an error. */
export function explorationFailureCount(parts: SessionMessageAssistantTool[]): number {
  return parts.filter((part) => part.state.status === 'error').length
}

type ToolCategory = 'read' | 'search' | 'fetch' | 'command' | 'edit'

const CATEGORY_ORDER: ToolCategory[] = ['read', 'search', 'fetch', 'command', 'edit']

const CATEGORY_NOUNS: Record<ToolCategory, [one: string, other: string]> = {
  read: ['{count} read', '{count} reads'],
  search: ['{count} search', '{count} searches'],
  fetch: ['{count} fetch', '{count} fetches'],
  command: ['{count} command', '{count} commands'],
  edit: ['{count} edit', '{count} edits'],
}

function toolCategory(name: string): ToolCategory {
  const tool = name.toLowerCase()
  if (tool === 'grep' || tool === 'glob' || tool === 'websearch') return 'search'
  if (tool === 'webfetch') return 'fetch'
  if (tool === 'shell' || tool === 'bash') return 'command'
  if (tool === 'read') return 'read'
  return 'edit'
}

/** TUI-style summary such as `Explored: 5 reads, 2 searches`, with a failure count when any tool errored. */
export function explorationLabel(parts: SessionMessageAssistantTool[]): string {
  const counts = new Map<ToolCategory, number>()
  parts.forEach((part) => {
    const category = toolCategory(part.name)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  })
  const names = CATEGORY_ORDER.filter((category) => counts.has(category)).map((category) => {
    const [one, other] = CATEGORY_NOUNS[category]
    return tn(one, other, counts.get(category) ?? 0)
  })
  const failures = explorationFailureCount(parts)
  const failureLabel = failures > 0 ? `, ${t('{count} failed', { count: failures })}` : ''
  const exploring = parts.every(isExplorationTool)
  const complete = isExplorationComplete(parts)
  const heading = exploring ? (complete ? t('Explored') : t('Exploring')) : complete ? t('Worked') : t('Working')
  return `${heading}: ${names.join(', ')}${failureLabel}`
}

/** Time from the first call's creation to the last completion, or to `now` while any call is still open. */
export function explorationElapsedMs(parts: SessionMessageAssistantTool[], now: number): number {
  const start = Math.min(...parts.map((part) => part.time.created))
  const end = isExplorationComplete(parts)
    ? Math.max(...parts.map((part) => part.time.completed ?? part.time.created))
    : now
  return Math.max(0, end - start)
}
