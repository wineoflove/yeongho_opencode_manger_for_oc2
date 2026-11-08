import type { WorkflowStatsResponse } from '@opencode-manager/shared/schemas'

export type WorkflowToolPart = {
  readonly id: string
  readonly sessionId: string
  readonly messageId: string
  readonly time: number
  readonly tool: string
  readonly status: string
  readonly error: string | null
  readonly inputHead: string | null
  readonly inputLength: number | null
  readonly command: string | null
  readonly filePath: string | null
  readonly exit: number | string | null
  readonly outputTail: string | null
  readonly metaOutputTail: string | null
  readonly timedOut: boolean | null
  readonly guardId: string | null
}

export type PreparedWorkflowToolPart = Omit<
  WorkflowToolPart,
  'inputHead' | 'inputLength' | 'command' | 'outputTail' | 'metaOutputTail' | 'timedOut'
> & {
  readonly repeatKey: string
  readonly inputPreview: string
  readonly bashFamily: string
  readonly bashTimeout: boolean
}

export type WorkflowStep = {
  readonly sessionId: string
  readonly messageId: string
  readonly time: number
  readonly agent: string | null
  readonly providerID: string | null
  readonly modelID: string | null
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export type WorkflowSession = {
  readonly id: string
  readonly parentId: string | null
  readonly title: string
  readonly timeCreated: number
}

export type WorkflowMessage = {
  readonly id: string
  readonly sessionId: string
  readonly time: number
  readonly role: string
  readonly summary: boolean | null
  readonly error: string | object | null
  readonly agent?: string | null
}

export type WorkflowReadPath = {
  readonly sessionId: string
  readonly time: number
  readonly filePath: string | null
}

export type WorkflowWindow = Readonly<WorkflowStatsResponse['window']>
export type WorkflowMetricsInput = {
  readonly range: WorkflowStatsResponse['range']
  readonly window: WorkflowWindow
  readonly previousWindow: WorkflowWindow
  readonly tools: readonly PreparedWorkflowToolPart[]
  readonly steps: readonly WorkflowStep[]
  readonly sessions: readonly WorkflowSession[]
  readonly messages: readonly WorkflowMessage[]
  readonly readPaths: readonly WorkflowReadPath[]
}

export type WorkflowComputedStats = Omit<
  WorkflowStatsResponse,
  'generatedAt' | 'window' | 'previousWindow' | 'mcpStatusSource' | 'mcp' | 'errorSignatures'
> & {
  readonly mcp: Omit<WorkflowStatsResponse['mcp'][number], 'status'>[]
  readonly errorSignatures: Omit<WorkflowStatsResponse['errorSignatures'][number], 'relatedLessonIds'>[]
}
