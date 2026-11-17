import { z } from 'zod'

const observationSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  enabledSchedules: z.number().int().nonnegative(),
  activeSchedules: z.number().int().nonnegative(),
  schedules: z.array(
    z.object({
      jobId: z.number().int().nonnegative(),
      nextRunAt: z.number().int().nonnegative().nullable(),
    }),
  ),
})
const budgetSchema = z.object({
  now: z.number().int().nonnegative(),
  maximumObservationAgeMs: z.number().int().positive(),
  executionBudgetMs: z.number().int().positive(),
  safetyMarginMs: z.number().int().nonnegative(),
})

type WindowResult =
  | {
      readonly sufficient: false
      readonly reason:
        | 'INVALID_INPUT'
        | 'STALE_OBSERVATION'
        | 'INCOMPLETE_INVENTORY'
        | 'WORK_ACTIVE'
        | 'RUN_TIME_UNKNOWN'
        | 'INSUFFICIENT_TIME'
    }
  | {
      readonly sufficient: true
      readonly availableMs: number | null
      readonly requiredMs: number
      readonly admissionFenced: false
    }

export function assessClaudeCutoverWindow(observation: unknown, budget: unknown): WindowResult {
  const parsedObservation = observationSchema.safeParse(observation)
  const parsedBudget = budgetSchema.safeParse(budget)
  if (!parsedObservation.success || !parsedBudget.success) return { sufficient: false, reason: 'INVALID_INPUT' }
  const state = parsedObservation.data
  const limits = parsedBudget.data
  const age = limits.now - state.observedAt
  if (age < 0 || age > limits.maximumObservationAgeMs) return { sufficient: false, reason: 'STALE_OBSERVATION' }
  if (
    state.schedules.length !== state.enabledSchedules ||
    new Set(state.schedules.map((entry) => entry.jobId)).size !== state.schedules.length
  )
    return { sufficient: false, reason: 'INCOMPLETE_INVENTORY' }
  if (state.activeSchedules) return { sufficient: false, reason: 'WORK_ACTIVE' }
  const requiredMs = limits.executionBudgetMs + limits.safetyMarginMs
  if (!Number.isSafeInteger(requiredMs)) return { sufficient: false, reason: 'INVALID_INPUT' }
  let availableMs: number | null = null
  for (const schedule of state.schedules) {
    if (schedule.nextRunAt === null) return { sufficient: false, reason: 'RUN_TIME_UNKNOWN' }
    const remaining = schedule.nextRunAt - limits.now
    if (remaining <= requiredMs) return { sufficient: false, reason: 'INSUFFICIENT_TIME' }
    availableMs = availableMs === null ? remaining : Math.min(availableMs, remaining)
  }
  return { sufficient: true, availableMs, requiredMs, admissionFenced: false }
}
