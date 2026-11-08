import { extname } from 'node:path'
import type { WorkflowBashRow, WorkflowLspRow } from '@opencode-manager/shared/schemas'
import { getMcpPrefix, getSessionKind, normalizeErrorSignature } from './workflow-classifiers'
import { computeWorkflowContext } from './workflow-context'
import type {
  WorkflowComputedStats,
  WorkflowMetricsInput,
  PreparedWorkflowToolPart,
  WorkflowWindow,
} from './workflow-types'

export { getBashFamily, stripBashPrefixes } from './workflow-classifiers'

function countRows(
  parts: readonly PreparedWorkflowToolPart[],
  keyOf: (part: PreparedWorkflowToolPart) => string | undefined,
) {
  const groups = new Map<string, { calls: number; errors: number }>()
  for (const part of parts) {
    const key = keyOf(part)
    if (key === undefined) continue
    const row = groups.get(key) ?? { calls: 0, errors: 0 }
    row.calls++
    row.errors += Number(part.status === 'error')
    groups.set(key, row)
  }
  return [...groups]
    .map(([key, row]) => ({ key, ...row, errorRate: Number((row.errors / row.calls).toFixed(4)) }))
    .sort((left, right) => right.errors - left.errors || right.calls - left.calls || left.key.localeCompare(right.key))
}

function computeWindow(input: WorkflowMetricsInput, window: WorkflowWindow) {
  const parts = input.tools.filter((part) => part.time >= window.from && part.time < window.to)
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const context = computeWorkflowContext(input, window)
  const groups = new Map<string, { part: PreparedWorkflowToolPart; count: number }>()
  const families = new Map<string, WorkflowBashRow>()
  for (const part of parts) {
    const key = part.repeatKey
    const group = groups.get(key) ?? { part, count: 0 }
    group.count++
    groups.set(key, group)
    if (part.tool !== 'bash') continue
    const family = part.bashFamily
    const row = families.get(family) ?? { family, calls: 0, nonzero: 0, timeouts: 0 }
    row.calls++
    row.nonzero += Number(typeof part.exit === 'number' && part.exit !== 0)
    row.timeouts += Number(part.bashTimeout)
    families.set(family, row)
  }
  const repeated = [...groups.values()]
    .filter((group) => group.count >= 3)
    .sort((left, right) => right.count - left.count)
  const bashFamilies = [...families.values()].sort(
    (left, right) => right.calls - left.calls || left.family.localeCompare(right.family),
  )
  const guards = (['G1', 'G3', 'G4'] as const).map((id) => ({
    id,
    blocked:
      id === 'G4'
        ? 0
        : parts.filter((part) => part.status === 'error' && part.error?.includes(`OCM_GUARD_${id}`)).length,
    adjusted: id === 'G1' ? 0 : parts.filter((part) => part.guardId === id).length,
  }))
  const statusErrors = parts.filter((part) => part.status === 'error').length
  const { firstCall, ...contextTotals } = context
  return {
    parts,
    bashFamilies,
    guards,
    firstCall,
    repeats: repeated.slice(0, 10).map(({ part, count }) => ({
      sessionId: part.sessionId,
      title: sessions.get(part.sessionId)?.title ?? '',
      tool: part.tool,
      count,
      inputPreview: part.inputPreview,
    })),
    totals: {
      ...contextTotals,
      toolCalls: parts.length,
      statusErrors,
      errorRate: parts.length ? Number((statusErrors / parts.length).toFixed(4)) : 0,
      bashCalls: bashFamilies.reduce((sum, row) => sum + row.calls, 0),
      bashNonzero: bashFamilies.reduce((sum, row) => sum + row.nonzero, 0),
      bashTimeouts: bashFamilies.reduce((sum, row) => sum + row.timeouts, 0),
      repeatedGroups: repeated.length,
      repeatedCalls: repeated.reduce((sum, group) => sum + group.count, 0),
      guardBlocked: parts.filter(
        (part) =>
          part.status === 'error' && (part.error?.includes('OCM_GUARD_G1') || part.error?.includes('OCM_GUARD_G3')),
      ).length,
      guardAdjusted: guards.reduce((sum, row) => sum + row.adjusted, 0),
    },
  }
}

export function computeWorkflowStats(input: WorkflowMetricsInput): WorkflowComputedStats {
  const current = computeWindow(input, input.window)
  const previous = computeWindow(input, input.previousWindow)
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const agents = new Map(input.messages.map((message) => [message.id, message.agent]))
  const signatures = new Map<string, { count: number; tools: Set<string> }>()
  const extensions = new Map<string, WorkflowLspRow>()
  const durations = new Map<number, number>()
  for (const part of current.parts) {
    if (part.status === 'error') {
      const signature = normalizeErrorSignature(part.error ?? '')
      const row = signatures.get(signature) ?? { count: 0, tools: new Set<string>() }
      row.count++
      row.tools.add(part.tool)
      signatures.set(signature, row)
    }
    if (part.tool !== 'lsp_diagnostics') continue
    const extension = extname(part.filePath ?? '').toLowerCase() || '<none>'
    const row = extensions.get(extension) ?? {
      extension,
      calls: 0,
      errors: 0,
      timeout: 0,
      outsideCwd: 0,
      enoent: 0,
      other: 0,
    }
    row.calls++
    if (part.status === 'error') {
      row.errors++
      const error = part.error ?? ''
      const timeout = /Timed out .*within\s+(\d+)ms/.exec(error)
      if (timeout) {
        row.timeout++
        const value = Number(timeout[1])
        durations.set(value, (durations.get(value) ?? 0) + 1)
      } else if (error.includes('inside request cwd')) row.outsideCwd++
      else if (error.includes('ENOENT')) row.enoent++
      else row.other++
    }
    extensions.set(extension, row)
  }
  const kindCounts = countRows(current.parts, (part) => getSessionKind(sessions.get(part.sessionId)))
  const activeSessions = new Set([
    ...current.parts.map((part) => part.sessionId),
    ...input.steps
      .filter((step) => step.time >= input.window.from && step.time < input.window.to)
      .map((step) => step.sessionId),
    ...input.messages
      .filter((message) => message.time >= input.window.from && message.time < input.window.to)
      .map((message) => message.sessionId),
    ...input.sessions
      .filter((session) => session.timeCreated >= input.window.from && session.timeCreated < input.window.to)
      .map((session) => session.id),
  ])
  return {
    range: input.range,
    totals: { current: current.totals, previous: previous.totals },
    tools: countRows(current.parts, (part) => part.tool)
      .slice(0, 25)
      .map(({ key, ...row }) => ({ tool: key, ...row })),
    agents: countRows(current.parts, (part) => agents.get(part.messageId) ?? '<unknown>').map(({ key, ...row }) => ({
      agent: key,
      ...row,
    })),
    kinds: (['interactive', 'scheduled', 'subagent'] as const).map((kind) => {
      const row = kindCounts.find((row) => row.key === kind)
      return {
        kind,
        sessions: [...activeSessions].filter((id) => getSessionKind(sessions.get(id)) === kind).length,
        calls: row?.calls ?? 0,
        errors: row?.errors ?? 0,
        errorRate: row?.errorRate ?? 0,
      }
    }),
    bashFamilies: current.bashFamilies,
    errorSignatures: [...signatures]
      .map(([signature, row]) => ({ signature, count: row.count, tools: [...row.tools].sort() }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          (left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0),
      )
      .slice(0, 20),
    repeats: current.repeats,
    mcp: countRows(current.parts, (part) => getMcpPrefix(part.tool)).map(({ key, ...row }) => ({
      prefix: key,
      ...row,
    })),
    lsp: {
      byExtension: [...extensions.values()].sort(
        (left, right) => right.calls - left.calls || left.extension.localeCompare(right.extension),
      ),
      timeoutMs: [...durations]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => left.value - right.value),
    },
    firstCall: current.firstCall,
    guards: current.guards,
  }
}
