import {
  TokenStatsBucketSchema,
  TokenStatsResponseSchema,
  type TokenStatsResponse,
} from '@opencode-manager/shared/schemas'
import {
  WorkflowStatsResponseSchema,
  WorkflowSessionTimelineSchema,
  type WorkflowRange,
  type WorkflowStatsResponse,
  type WorkflowSessionTimeline,
} from '@opencode-manager/shared/schemas'
import { z } from 'zod'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'
import type { StatsViewState } from '@/lib/tokenStats'

export interface TokenStatsRequest extends Pick<StatsViewState, 'groupBy' | 'splitBy' | 'filters'> {
  readonly from: number
  readonly to: number
  readonly tzOffsetMinutes: number
}

export function buildTokenStatsParams(request: TokenStatsRequest): URLSearchParams {
  const params = new URLSearchParams({
    from: String(request.from),
    to: String(request.to),
    tz: String(request.tzOffsetMinutes),
    groupBy: request.groupBy,
    splitBy: request.splitBy,
  })
  for (const filter of request.filters) params.append('filter', `${filter.dimension}:${filter.value}`)
  return params
}

const CompatibleTokenStatsResponseSchema = TokenStatsResponseSchema.extend({
  buckets: z.array(
    TokenStatsBucketSchema.extend({
      messages: TokenStatsBucketSchema.shape.messages.default(0),
      sessions: TokenStatsBucketSchema.shape.sessions.default(0),
      accountTokens: TokenStatsBucketSchema.shape.accountTokens.default(0),
      tokens: TokenStatsBucketSchema.shape.tokens.default({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      providers: TokenStatsBucketSchema.shape.providers.default({}),
    }),
  ),
})

export async function fetchTokenStats(request: TokenStatsRequest): Promise<TokenStatsResponse> {
  return CompatibleTokenStatsResponseSchema.parse(
    await fetchWrapper<unknown>(`${API_BASE_URL}/api/stats/tokens?${buildTokenStatsParams(request).toString()}`),
  )
}

export async function fetchWorkflowStats(range: WorkflowRange): Promise<WorkflowStatsResponse> {
  return WorkflowStatsResponseSchema.parse(await fetchWrapper(`${API_BASE_URL}/api/stats/workflow?range=${range}`))
}

export async function fetchWorkflowSession(sessionId: string): Promise<WorkflowSessionTimeline> {
  return WorkflowSessionTimelineSchema.parse(
    await fetchWrapper(`${API_BASE_URL}/api/stats/workflow/sessions/${encodeURIComponent(sessionId)}`),
  )
}

const LearningLintSchema = z.object({
  scanned: z.number().int().nonnegative(),
  counts: z.object({ verified: z.number(), pending: z.number(), superseded: z.number(), other: z.number() }),
  violations: z.array(z.object({ file: z.string(), code: z.string(), detail: z.string() })),
})

export type LearningLint = z.infer<typeof LearningLintSchema>

export async function fetchLearningLint(): Promise<LearningLint> {
  return LearningLintSchema.parse(await fetchWrapper(`${API_BASE_URL}/api/learnings/lint`))
}
