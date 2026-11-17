import { z } from 'zod'
import { assessClaudeCutoverWindow } from './claude-cutover-window'

const count = z.number().int().nonnegative()
const observationSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  counts: z.object({
    expectedDirectories: count.positive(),
    idleDirectories: count,
    busyDirectories: count,
    unknownDirectories: count,
    busySessions: count,
    enabledSchedules: count,
    activeSchedules: count,
    activeRecovery: count,
  }),
  terminal: z.object({
    ready: z.boolean(),
    terminalSessions: count.nullable(),
  }),
  recoveryStates: z.array(
    z.object({
      state: z.enum(['active', 'pending', 'claimed', 'completed', 'cancelled', 'failed', 'ambiguous']),
      active: count.nullable(),
      count,
      eligiblePending: count,
    }),
  ),
  inventoryBlockers: z.array(z.string()),
  schedules: z.array(z.object({ jobId: count, nextRunAt: count.nullable() })),
})

export class LegacyReadinessReportError extends Error {
  constructor() {
    super('LEGACY_READINESS_REPORT_INVALID')
    this.name = 'LegacyReadinessReportError'
  }
}

export function legacyWindowObservationFromReport(input: unknown) {
  const parsed = z
    .object({
      observedAt: z.string().datetime(),
      counts: observationSchema.shape.counts,
      terminal: observationSchema.shape.terminal,
      recoveryStates: observationSchema.shape.recoveryStates,
      scheduleTiming: observationSchema.shape.schedules,
      blockers: z.array(z.string()),
    })
    .safeParse(input)
  if (!parsed.success) throw new LegacyReadinessReportError()
  const handled = new Set([
    'busySessions',
    'unknownDirectories',
    'enabledSchedules',
    'activeSchedules',
    'activeRecovery',
    'admission_not_fenced',
    'TERMINAL_STATUS_UNVERIFIED',
    'TERMINALS_PRESENT',
  ])
  return {
    observedAt: Date.parse(parsed.data.observedAt),
    counts: parsed.data.counts,
    terminal: parsed.data.terminal,
    recoveryStates: parsed.data.recoveryStates,
    schedules: parsed.data.scheduleTiming,
    inventoryBlockers: parsed.data.blockers.filter((reason) => !handled.has(reason)).map(() => 'unverified-inventory'),
  }
}

export function assessLegacyMaintenanceWindow(observation: unknown, budget: unknown) {
  const parsed = observationSchema.safeParse(observation)
  if (!parsed.success) return { eligible: false, reason: 'INVALID_OBSERVATION' } as const
  const state = parsed.data
  const counts = state.counts
  if (
    state.inventoryBlockers.length ||
    counts.idleDirectories + counts.busyDirectories + counts.unknownDirectories !== counts.expectedDirectories ||
    counts.unknownDirectories
  )
    return { eligible: false, reason: 'INCOMPLETE_INVENTORY' } as const
  if (
    counts.busyDirectories ||
    counts.busySessions ||
    counts.activeSchedules ||
    counts.activeRecovery ||
    state.recoveryStates.some(
      (row) => row.count > 0 && (row.active !== 0 || row.state === 'pending' || row.state === 'claimed'),
    )
  )
    return { eligible: false, reason: 'WORK_ACTIVE' } as const
  if (!state.terminal.ready || state.terminal.terminalSessions !== 0)
    return {
      eligible: false,
      reason: 'TERMINAL_UNVERIFIED_OR_ACTIVE',
    } as const
  const window = assessClaudeCutoverWindow(
    {
      observedAt: state.observedAt,
      enabledSchedules: counts.enabledSchedules,
      activeSchedules: counts.activeSchedules,
      schedules: state.schedules,
    },
    budget,
  )
  if (!window.sufficient) return { eligible: false, reason: window.reason } as const
  return {
    eligible: true,
    phase: 'frontend-maintenance-entry-only',
    admissionFenced: false,
    backendStopAllowed: false,
    dataMutationAllowed: false,
    availableMs: window.availableMs,
    requiredMs: window.requiredMs,
  } as const
}
