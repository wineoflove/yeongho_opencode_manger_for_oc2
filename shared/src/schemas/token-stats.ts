import { z } from 'zod'

export const TOKEN_FILTER_DIMENSIONS = [
  'model',
  'provider',
  'account',
  'project',
  'agent',
  'category',
  'session',
] as const
export const TOKEN_GROUP_DIMENSIONS = [...TOKEN_FILTER_DIMENSIONS, 'day'] as const
export const TOKEN_TYPES = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const

export const TokenFilterDimensionSchema = z.enum(TOKEN_FILTER_DIMENSIONS)
export const TokenGroupDimensionSchema = z.enum(TOKEN_GROUP_DIMENSIONS)
export const TokenSplitSchema = z.union([z.literal('tokenType'), TokenFilterDimensionSchema])

export const TokenStatsFilterSchema = z.object({
  dimension: TokenFilterDimensionSchema,
  value: z.string().min(1).max(512),
})

export const TokenStatsQuerySchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    tzOffsetMinutes: z.number().int().min(-840).max(840).default(0),
    groupBy: TokenGroupDimensionSchema.default('model'),
    splitBy: TokenSplitSchema.default('tokenType'),
    filters: z.array(TokenStatsFilterSchema).max(50).default([]),
  })
  .refine((query) => query.from < query.to, { message: 'from must be before to' })

export const TokenTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
  cost: z.number(),
  estimatedCost: z.number(),
  unpricedMessages: z.number().int(),
  messages: z.number().int(),
  sessions: z.number().int(),
})

export const TokenStatsSeriesSchema = z.object({ key: z.string(), label: z.string() })

export const TokenTypeTotalsSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number(),
})

export const TokenStatsBucketSchema = z.object({
  start: z.number().int(),
  values: z.array(z.number()),
  total: z.number(),
  cost: z.number(),
  estimatedCost: z.number(),
  unpricedMessages: z.number().int(),
  messages: z.number().int(),
  sessions: z.number().int(),
  accountTokens: z.number(),
  tokens: TokenTypeTotalsSchema,
  providers: z.record(z.string(), z.number()),
})

export const TokenStatsRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  totals: TokenTotalsSchema,
  share: z.number(),
})

export const TokenStatsFacetValueSchema = z.object({ key: z.string(), label: z.string(), total: z.number() })

export const TokenStatsResponseSchema = z.object({
  generatedAt: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  interval: z.enum(['hour', 'day']),
  totals: TokenTotalsSchema,
  previous: TokenTotalsSchema,
  series: z.array(TokenStatsSeriesSchema),
  buckets: z.array(TokenStatsBucketSchema),
  breakdown: z.array(TokenStatsRowSchema),
  facets: z.record(TokenFilterDimensionSchema, z.array(TokenStatsFacetValueSchema)),
  attribution: z.object({
    accountTokens: z.number(),
    trackedSince: z.number().int().nullable(),
  }),
  index: z.object({
    messages: z.number().int(),
    firstMessageAt: z.number().int().nullable(),
  }),
})

export type TokenFilterDimension = z.infer<typeof TokenFilterDimensionSchema>
export type TokenGroupDimension = z.infer<typeof TokenGroupDimensionSchema>
export type TokenSplit = z.infer<typeof TokenSplitSchema>
export type TokenType = (typeof TOKEN_TYPES)[number]
export type TokenStatsFilter = z.infer<typeof TokenStatsFilterSchema>
export type TokenStatsQuery = z.infer<typeof TokenStatsQuerySchema>
export type TokenTotals = z.infer<typeof TokenTotalsSchema>
export type TokenStatsRow = z.infer<typeof TokenStatsRowSchema>
export type TokenStatsBucket = z.infer<typeof TokenStatsBucketSchema>
export type TokenTypeTotals = z.infer<typeof TokenTypeTotalsSchema>
export type TokenStatsFacetValue = z.infer<typeof TokenStatsFacetValueSchema>
export type TokenStatsResponse = z.infer<typeof TokenStatsResponseSchema>
