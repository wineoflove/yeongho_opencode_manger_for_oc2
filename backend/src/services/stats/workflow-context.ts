import type { WorkflowFirstCall } from '@opencode-manager/shared/schemas'
import { getSessionKind } from './workflow-classifiers'
import type { PreparedWorkflowToolPart, WorkflowMetricsInput, WorkflowReadPath, WorkflowWindow } from './workflow-types'

export function computeWorkflowContext(input: WorkflowMetricsInput, window: WorkflowWindow) {
  const inWindow = (time: number) => time >= window.from && time < window.to
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const agents = new Map(input.messages.map((message) => [message.id, message.agent]))
  const steps = input.steps.filter((step) => inWindow(step.time)).sort((left, right) => left.time - right.time)
  const messages = input.messages.filter((message) => inWindow(message.time))
  const inputContextTokens = steps.reduce((sum, step) => sum + step.input + step.cacheRead + step.cacheWrite, 0)
  const userMessages = messages.filter(
    (message) => message.role === 'user' && getSessionKind(sessions.get(message.sessionId)) === 'interactive',
  ).length
  const firstSessions = new Set<string>()
  const byAgent = new Map<string, number[]>()
  for (const step of steps) {
    const session = sessions.get(step.sessionId)
    if (!session || !inWindow(session.timeCreated) || firstSessions.has(step.sessionId)) continue
    firstSessions.add(step.sessionId)
    const agent = agents.get(step.messageId) ?? step.agent ?? '<unknown>'
    const values = byAgent.get(agent) ?? []
    values.push(step.input + step.cacheRead + step.cacheWrite)
    byAgent.set(agent, values)
  }
  const firstCall: WorkflowFirstCall[] = []
  for (const [agent, values] of byAgent) {
    if (values.length < 3) continue
    values.sort((left, right) => left - right)
    const middle = Math.floor(values.length / 2)
    const medianTokens = ((values[middle] ?? 0) + (values[Math.floor((values.length - 1) / 2)] ?? 0)) / 2
    firstCall.push({ agent, sessions: values.length, medianTokens })
  }
  firstCall.sort((left, right) => right.sessions - left.sessions || left.agent.localeCompare(right.agent))
  const compactions = messages.filter((message) => message.summary === true)
  const readsBySession = new Map<string, WorkflowReadPath[]>()
  const toolsBySession = new Map<string, PreparedWorkflowToolPart[]>()
  for (const read of input.readPaths) {
    const reads = readsBySession.get(read.sessionId) ?? []
    reads.push(read)
    readsBySession.set(read.sessionId, reads)
  }
  for (const part of input.tools) {
    const tools = toolsBySession.get(part.sessionId) ?? []
    tools.push(part)
    toolsBySession.set(part.sessionId, tools)
    if (part.tool !== 'read') continue
    const reads = readsBySession.get(part.sessionId) ?? []
    reads.push(part)
    readsBySession.set(part.sessionId, reads)
  }
  for (const tools of toolsBySession.values()) tools.sort((left, right) => left.time - right.time)
  const rereads = compactions.map((message) => {
    const before = new Set(
      (readsBySession.get(message.sessionId) ?? [])
        .filter((read) => read.time < message.time && read.filePath)
        .map((read) => read.filePath),
    )
    return (toolsBySession.get(message.sessionId) ?? [])
      .filter((part) => part.time > message.time)
      .slice(0, 30)
      .filter((part) => part.tool === 'read' && part.filePath && before.has(part.filePath)).length
  })
  return {
    firstCall,
    inputContextTokens,
    userMessages,
    tokensPerUserMessage: userMessages ? inputContextTokens / userMessages : null,
    compactions: compactions.length,
    compactionErrors: compactions.filter((message) => message.error != null).length,
    avgRereadsAfterCompaction: rereads.length
      ? Number((rereads.reduce((sum, value) => sum + value, 0) / rereads.length).toFixed(2))
      : null,
  }
}
