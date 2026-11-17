import { describe, expect, it } from 'vitest'
import { assessLegacyMaintenanceWindow } from '../../src/services/legacy-maintenance-window'

const budget = {
  now: 1000000,
  maximumObservationAgeMs: 5000,
  executionBudgetMs: 60000,
  safetyMarginMs: 10000,
}
const idle = {
  observedAt: budget.now,
  counts: {
    expectedDirectories: 2,
    idleDirectories: 2,
    busyDirectories: 0,
    unknownDirectories: 0,
    busySessions: 0,
    enabledSchedules: 1,
    activeSchedules: 0,
    activeRecovery: 0,
  },
  terminal: { ready: true, terminalSessions: 0 },
  recoveryStates: [],
  inventoryBlockers: [],
  schedules: [{ jobId: 1, nextRunAt: budget.now + 100000 }],
}
describe('legacy frontend maintenance entry window', () => {
  it('allows only frontend maintenance entry when idle work fits before an enabled schedule', () => {
    expect(assessLegacyMaintenanceWindow(idle, budget)).toEqual({
      eligible: true,
      phase: 'frontend-maintenance-entry-only',
      admissionFenced: false,
      backendStopAllowed: false,
      dataMutationAllowed: false,
      availableMs: 100000,
      requiredMs: 70000,
    })
  })
  it.each(['busySessions', 'activeSchedules', 'activeRecovery'] as const)('blocks %s', (key) => {
    expect(assessLegacyMaintenanceWindow({ ...idle, counts: { ...idle.counts, [key]: 1 } }, budget)).toEqual({
      eligible: false,
      reason: 'WORK_ACTIVE',
    })
  })
  it('blocks a pending recovery even if the active flag is zero', () => {
    expect(
      assessLegacyMaintenanceWindow(
        {
          ...idle,
          recoveryStates: [{ state: 'pending', active: 0, count: 1, eligiblePending: 0 }],
        },
        budget,
      ),
    ).toEqual({ eligible: false, reason: 'WORK_ACTIVE' })
  })
  it.each([
    { ...idle, counts: { ...idle.counts, idleDirectories: 1 } },
    { ...idle, inventoryBlockers: ['workspace_scope_unverified'] },
  ])('blocks incomplete directory inventory', (input) => {
    expect(assessLegacyMaintenanceWindow(input, budget)).toEqual({
      eligible: false,
      reason: 'INCOMPLETE_INVENTORY',
    })
  })
  it.each([
    { ready: false, terminalSessions: null },
    { ready: true, terminalSessions: 1 },
  ])('blocks terminal uncertainty or activity', (terminal) => {
    expect(assessLegacyMaintenanceWindow({ ...idle, terminal }, budget)).toEqual({
      eligible: false,
      reason: 'TERMINAL_UNVERIFIED_OR_ACTIVE',
    })
  })
  it('blocks stale observation and an upcoming schedule at the exact budget boundary', () => {
    expect(assessLegacyMaintenanceWindow({ ...idle, observedAt: budget.now - 5001 }, budget)).toEqual({
      eligible: false,
      reason: 'STALE_OBSERVATION',
    })
    expect(
      assessLegacyMaintenanceWindow({ ...idle, schedules: [{ jobId: 1, nextRunAt: budget.now + 70000 }] }, budget),
    ).toEqual({ eligible: false, reason: 'INSUFFICIENT_TIME' })
  })
})
