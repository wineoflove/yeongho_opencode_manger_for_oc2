import { z } from 'zod'

const countsSchema = z.object({
  enabledSchedules: z.number().int().nonnegative(),
  activeSchedules: z.number().int().nonnegative(),
  activeRecovery: z.number().int().nonnegative(),
  busySessions: z.number().int().nonnegative(),
  checkedDirectories: z.number().int().positive(),
})
const statusSchema = z.object({
  schemaVersion: z.literal(1),
  ready: z.boolean(),
  counts: countsSchema,
  blockers: z.array(z.string()),
})

export type ClaudeReadiness =
  | { readonly ready: true; readonly counts: z.infer<typeof countsSchema> }
  | {
      readonly ready: false
      readonly reason:
        'STATUS_ACCESS_UNCONFIRMED' | 'STATUS_UNAVAILABLE' | 'STATUS_INVALID' | 'WORK_ACTIVE' | 'ADMISSION_NOT_FENCED'
    }

export function evaluateClaudeCutoverReadiness(
  response: { readonly status: number; readonly body: unknown },
  admissionFenced: boolean,
): ClaudeReadiness {
  if (response.status === 401 || response.status === 403) return { ready: false, reason: 'STATUS_ACCESS_UNCONFIRMED' }
  if (response.status !== 200) return { ready: false, reason: 'STATUS_UNAVAILABLE' }
  const parsed = statusSchema.safeParse(response.body)
  if (!parsed.success) return { ready: false, reason: 'STATUS_INVALID' }
  const { counts } = parsed.data
  if (
    !parsed.data.ready ||
    parsed.data.blockers.length ||
    counts.enabledSchedules ||
    counts.activeSchedules ||
    counts.activeRecovery ||
    counts.busySessions
  )
    return { ready: false, reason: 'WORK_ACTIVE' }
  if (!admissionFenced) return { ready: false, reason: 'ADMISSION_NOT_FENCED' }
  return { ready: true, counts }
}
