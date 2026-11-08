import { z } from 'zod'
import {
  ScheduleDeliveryStatusSchema,
  ScheduleRunOutcomeSchema,
  ScheduleRunStatusSchema,
  ScheduleUsageTotalsSchema,
} from './schedule'

const WindowDaysSchema = z.union([z.literal(1), z.literal(7), z.literal(30)])
const WindowSchema = z.object({ from: z.number(), to: z.number() })
const CountSchema = z.number().int()
const OutcomesSchema = z.record(ScheduleRunOutcomeSchema, CountSchema)
const SuccessRateSchema = z.number().min(0).max(1).nullable()

export const ScheduleOverviewQuerySchema = z.object({
  windowDays: z.coerce.number().pipe(WindowDaysSchema).default(7),
  tz: z.string().trim().min(1).max(64).optional(),
})
export type ScheduleOverviewQuery = z.infer<typeof ScheduleOverviewQuerySchema>

export const ScheduleOverviewTotalsSchema = z.object({
  runs: CountSchema,
  terminal: CountSchema,
  outcomes: OutcomesSchema,
  successRate: SuccessRateSchema,
  avgDurationMs: z.number().nullable(),
  p90DurationMs: z.number().nullable(),
  processed: CountSchema,
  runsWithUsage: CountSchema,
  tokens: CountSchema,
  recordedCost: z.number(),
  estimatedCost: z.number().nullable(),
})
export type ScheduleOverviewTotals = z.infer<typeof ScheduleOverviewTotalsSchema>

export const ScheduleOverviewBucketSchema = z.object({
  start: z.number(),
  label: z.string().max(8),
  runs: CountSchema,
  outcomes: OutcomesSchema,
  avgDurationMs: z.number().nullable(),
  maxConcurrent: CountSchema,
  processed: CountSchema,
  tokens: CountSchema,
  estimatedCost: z.number().nullable(),
})
export type ScheduleOverviewBucket = z.infer<typeof ScheduleOverviewBucketSchema>

export const ScheduleOverviewRunningSchema = z.object({
  runId: z.number(),
  jobId: z.number(),
  repoId: z.number().nullable(),
  serverId: z.string(),
  directory: z.string().nullable(),
  jobName: z.string(),
  repoName: z.string(),
  agentSlug: z.string().nullable(),
  startedAt: z.number(),
  sessionId: z.string().nullable(),
  deadlineAt: z.number(),
  typicalDurationMs: z.number().nullable(),
})
export type ScheduleOverviewRunning = z.infer<typeof ScheduleOverviewRunningSchema>

export const ScheduleOverviewUpcomingSchema = z.object({
  jobId: z.number(),
  repoId: z.number().nullable(),
  serverId: z.string(),
  directory: z.string().nullable(),
  name: z.string(),
  at: z.number(),
  kind: z.enum(['cron', 'interval']),
})
export type ScheduleOverviewUpcoming = z.infer<typeof ScheduleOverviewUpcomingSchema>

export const ScheduleOverviewRecentRunSchema = z.object({
  runId: z.number(),
  startedAt: z.number(),
  status: ScheduleRunStatusSchema,
  outcome: ScheduleRunOutcomeSchema.nullable(),
  durationMs: z.number().nullable(),
})
export type ScheduleOverviewRecentRun = z.infer<typeof ScheduleOverviewRecentRunSchema>

export const ScheduleOverviewJobSchema = z.object({
  jobId: z.number(),
  repoId: z.number().nullable(),
  serverId: z.string(),
  directory: z.string().nullable(),
  repoName: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  scheduleLabel: z.string(),
  timezone: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  agentSlug: z.string().nullable(),
  agentStatus: z.enum(['ok', 'mismatch', 'unavailable', 'unknown']),
  agentUsed: z.string().nullable(),
  lastRun: z
    .object({
      id: z.number(),
      status: ScheduleRunStatusSchema,
      outcome: ScheduleRunOutcomeSchema.nullable(),
      startedAt: z.number(),
      finishedAt: z.number().nullable(),
      summary: z.string().nullable(),
    })
    .nullable(),
  runs: CountSchema,
  outcomes: OutcomesSchema,
  successRate: SuccessRateSchema,
  avgDurationMs: z.number().nullable(),
  p90DurationMs: z.number().nullable(),
  processed: CountSchema.nullable(),
  remaining: CountSchema.nullable(),
  unit: z.string().nullable(),
  delivery: ScheduleDeliveryStatusSchema.nullable(),
  usage: z
    .object({
      runsWithUsage: CountSchema,
      totals: ScheduleUsageTotalsSchema,
      perRunAvgTokens: z.number().nullable(),
      recordedCost: z.number(),
      estimatedCost: z.number().nullable(),
      unpricedRuns: CountSchema,
    })
    .nullable(),
  overlaps: z.array(z.object({ jobId: z.number(), name: z.string(), at: z.number() })).max(10),
  recentRuns: z.array(ScheduleOverviewRecentRunSchema).max(20),
})
export type ScheduleOverviewJob = z.infer<typeof ScheduleOverviewJobSchema>

export const ScheduleOverviewResponseSchema = z.object({
  generatedAt: z.number(),
  windowDays: WindowDaysSchema,
  tz: z.string(),
  enabledJobs: CountSchema,
  totalJobs: CountSchema,
  window: WindowSchema,
  previousWindow: WindowSchema,
  totals: z.object({ current: ScheduleOverviewTotalsSchema, previous: ScheduleOverviewTotalsSchema }),
  series: z.array(ScheduleOverviewBucketSchema).max(30),
  running: z.array(ScheduleOverviewRunningSchema),
  upcoming: z.array(ScheduleOverviewUpcomingSchema).max(8),
  jobs: z.array(ScheduleOverviewJobSchema),
})
export type ScheduleOverviewResponse = z.infer<typeof ScheduleOverviewResponseSchema>
