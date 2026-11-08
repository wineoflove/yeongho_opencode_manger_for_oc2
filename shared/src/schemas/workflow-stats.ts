import { z } from 'zod'

const CountSchema = z.number().int().nonnegative()
const ErrorRateSchema = z.number().min(0).max(1)
const WindowSchema = z.object({ from: z.number(), to: z.number() })

export const WorkflowRangeSchema = z.enum(['24h', '7d', '30d'])
export type WorkflowRange = z.infer<typeof WorkflowRangeSchema>

export const WorkflowTotalsSchema = z.object({
  toolCalls: CountSchema,
  statusErrors: CountSchema,
  errorRate: ErrorRateSchema,
  bashCalls: CountSchema,
  bashNonzero: CountSchema,
  bashTimeouts: CountSchema,
  repeatedGroups: CountSchema,
  repeatedCalls: CountSchema,
  compactions: CountSchema,
  compactionErrors: CountSchema,
  avgRereadsAfterCompaction: z.number().nullable(),
  userMessages: CountSchema,
  inputContextTokens: CountSchema,
  tokensPerUserMessage: z.number().nullable(),
  guardBlocked: CountSchema,
  guardAdjusted: CountSchema,
})
export type WorkflowTotals = z.infer<typeof WorkflowTotalsSchema>

export const WorkflowToolRowSchema = z.object({
  tool: z.string(),
  calls: CountSchema,
  errors: CountSchema,
  errorRate: ErrorRateSchema,
})
export type WorkflowToolRow = z.infer<typeof WorkflowToolRowSchema>

export const WorkflowAgentRowSchema = z.object({
  agent: z.string(),
  calls: CountSchema,
  errors: CountSchema,
  errorRate: ErrorRateSchema,
})
export type WorkflowAgentRow = z.infer<typeof WorkflowAgentRowSchema>

export const WorkflowKindRowSchema = z.object({
  kind: z.enum(['scheduled', 'subagent', 'interactive']),
  sessions: CountSchema,
  calls: CountSchema,
  errors: CountSchema,
  errorRate: ErrorRateSchema,
})
export type WorkflowKindRow = z.infer<typeof WorkflowKindRowSchema>

export const WorkflowBashRowSchema = z.object({
  family: z.string(),
  calls: CountSchema,
  nonzero: CountSchema,
  timeouts: CountSchema,
})
export type WorkflowBashRow = z.infer<typeof WorkflowBashRowSchema>

export const WorkflowErrorSignatureSchema = z.object({
  signature: z.string().max(120),
  count: CountSchema,
  tools: z.array(z.string()),
  relatedLessonIds: z.array(z.string()).nullable(),
})
export type WorkflowErrorSignature = z.infer<typeof WorkflowErrorSignatureSchema>

export const WorkflowRepeatSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  tool: z.string(),
  count: CountSchema,
  inputPreview: z.string().max(140),
})
export type WorkflowRepeat = z.infer<typeof WorkflowRepeatSchema>

export const WorkflowMcpRowSchema = z.object({
  prefix: z.string(),
  calls: CountSchema,
  errors: CountSchema,
  errorRate: ErrorRateSchema,
  status: z.string().nullable(),
})
export type WorkflowMcpRow = z.infer<typeof WorkflowMcpRowSchema>

export const WorkflowLspRowSchema = z.object({
  extension: z.string(),
  calls: CountSchema,
  errors: CountSchema,
  timeout: CountSchema,
  outsideCwd: CountSchema,
  enoent: CountSchema,
  other: CountSchema,
})
export type WorkflowLspRow = z.infer<typeof WorkflowLspRowSchema>

export const WorkflowFirstCallSchema = z.object({
  agent: z.string(),
  sessions: CountSchema,
  medianTokens: z.number(),
})
export type WorkflowFirstCall = z.infer<typeof WorkflowFirstCallSchema>

export const WorkflowGuardRowSchema = z.object({
  id: z.enum(['G1', 'G3', 'G4']),
  blocked: CountSchema,
  adjusted: CountSchema,
})
export type WorkflowGuardRow = z.infer<typeof WorkflowGuardRowSchema>

export const WorkflowStatsResponseSchema = z.object({
  generatedAt: z.number(),
  range: WorkflowRangeSchema,
  window: WindowSchema,
  previousWindow: WindowSchema,
  totals: z.object({ current: WorkflowTotalsSchema, previous: WorkflowTotalsSchema }),
  tools: z.array(WorkflowToolRowSchema).max(25),
  agents: z.array(WorkflowAgentRowSchema),
  kinds: z.array(WorkflowKindRowSchema),
  bashFamilies: z.array(WorkflowBashRowSchema),
  errorSignatures: z.array(WorkflowErrorSignatureSchema).max(20),
  repeats: z.array(WorkflowRepeatSchema).max(10),
  mcp: z.array(WorkflowMcpRowSchema),
  mcpStatusSource: z.string().nullable(),
  lsp: z.object({
    byExtension: z.array(WorkflowLspRowSchema),
    timeoutMs: z.array(z.object({ value: z.number(), count: CountSchema })),
  }),
  firstCall: z.array(WorkflowFirstCallSchema),
  guards: z.array(WorkflowGuardRowSchema),
})
export type WorkflowStatsResponse = z.infer<typeof WorkflowStatsResponseSchema>

export const WorkflowSessionTimelineSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  directory: z.string(),
  parentId: z.string().nullable(),
  steps: z
    .array(
      z.object({
        at: z.number(),
        messageId: z.string(),
        agent: z.string().nullable(),
        model: z.string().nullable(),
        contextTokens: CountSchema,
        outputTokens: CountSchema,
        toolCalls: CountSchema,
        toolErrors: CountSchema,
        guardEvents: CountSchema,
      }),
    )
    .max(2000),
  compactions: z.array(z.object({ at: z.number(), messageId: z.string() })),
})
export type WorkflowSessionTimeline = z.infer<typeof WorkflowSessionTimelineSchema>
