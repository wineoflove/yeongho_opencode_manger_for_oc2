import { describe, expect, it } from 'vitest'
import {
  assessLegacyMaintenanceWindow,
  legacyWindowObservationFromReport,
} from '../../src/services/legacy-maintenance-window'

const now = 1000000
const budget = {
  now,
  maximumObservationAgeMs: 5000,
  executionBudgetMs: 60000,
  safetyMarginMs: 10000,
}
function report() {
  return {
    observedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(),
    counts: {
      expectedDirectories: 1,
      idleDirectories: 1,
      busyDirectories: 0,
      unknownDirectories: 0,
      busySessions: 0,
      enabledSchedules: 0,
      activeSchedules: 0,
      activeRecovery: 0,
    },
    terminal: { ready: true, terminalSessions: 0 },
    recoveryStates: [],
    scheduleTiming: [],
    blockers: ['admission_not_fenced'],
  }
}
describe('operational readiness report adapter', () => {
  it('recomputes eligibility from counts instead of trusting a green child summary', () => {
    const value = report()
    const parsed = legacyWindowObservationFromReport({
      ...value,
      ready: true,
      frontendMaintenanceEntry: { eligible: true },
      counts: { ...value.counts, busySessions: 1 },
    })
    expect(assessLegacyMaintenanceWindow(parsed, budget)).toEqual({
      eligible: false,
      reason: 'WORK_ACTIVE',
    })
  })
  it('keeps initial observation time instead of refreshing it from report completion', () => {
    const parsed = legacyWindowObservationFromReport({
      ...report(),
      observedAt: new Date(now - 5001).toISOString(),
    })
    expect(assessLegacyMaintenanceWindow(parsed, budget)).toEqual({
      eligible: false,
      reason: 'STALE_OBSERVATION',
    })
  })
  it('redacts unknown blocker strings but still fails closed', () => {
    const parsed = legacyWindowObservationFromReport({
      ...report(),
      blockers: ['synthetic-sensitive-provider-error'],
    })
    expect(parsed.inventoryBlockers).toEqual(['unverified-inventory'])
    expect(JSON.stringify(parsed)).not.toContain('synthetic-sensitive-provider-error')
    expect(assessLegacyMaintenanceWindow(parsed, budget)).toEqual({
      eligible: false,
      reason: 'INCOMPLETE_INVENTORY',
    })
  })
  it('does not fill missing recovery data with an empty inventory', () => {
    expect(() =>
      legacyWindowObservationFromReport({
        ...report(),
        recoveryStates: undefined,
      }),
    ).toThrow('LEGACY_READINESS_REPORT_INVALID')
  })
})
