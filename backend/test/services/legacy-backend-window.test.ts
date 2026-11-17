import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assessLegacyBackendWindow } from '../../src/services/legacy-backend-window'
import * as quiescence from '../../src/services/claude-transfer-quiescence'

const budget = {
  now: 1000000,
  maximumObservationAgeMs: 5000,
  executionBudgetMs: 60000,
  safetyMarginMs: 10000,
}
const observation = {
  observedAt: budget.now,
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
  terminal: { ready: false, terminalSessions: null },
  recoveryStates: [],
  inventoryBlockers: [],
  schedules: [],
}
const input = {
  observation,
  budget,
  stoppedTerminal: {
    label: 'io.wineoflove.ocm.terminal',
    port: 5104,
    pids: [12345],
    registered: false,
  },
  assertFrontendReadOnly: async () => {},
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(budget.now)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('backend entry after an independently verified terminal stop', () => {
  it('rejects an observation that becomes stale while asynchronous checks run', async () => {
    vi.spyOn(quiescence, 'assertClaudeTransferStopped').mockResolvedValue(undefined)
    expect(
      await assessLegacyBackendWindow({
        ...input,
        assertFrontendReadOnly: async () => {
          vi.setSystemTime(budget.now + 5001)
        },
      }),
    ).toEqual({ eligible: false, reason: 'STALE_OBSERVATION' })
  })
  it('still rejects when the terminal is registered despite an idle-looking report', async () => {
    expect(
      await assessLegacyBackendWindow({
        ...input,
        stoppedTerminal: { ...input.stoppedTerminal, registered: true },
      }),
    ).toEqual({ eligible: false, reason: 'INVALID_STOPPED_TERMINAL_SCOPE' })
  })
  it('does not infer stop from an unreachable terminal API', async () => {
    vi.spyOn(quiescence, 'assertClaudeTransferStopped').mockRejectedValue(new Error('present'))
    expect(await assessLegacyBackendWindow(input)).toEqual({
      eligible: false,
      reason: 'TERMINAL_STOP_UNVERIFIED',
    })
  })
  it('requires a confirmed frontend gate', async () => {
    expect(
      await assessLegacyBackendWindow({
        ...input,
        assertFrontendReadOnly: async () => {
          throw new Error('open')
        },
      }),
    ).toEqual({ eligible: false, reason: 'FRONTEND_GATE_UNVERIFIED' })
  })
  it('allows only backend stop entry after kernel stop evidence and keeps data mutation closed', async () => {
    vi.spyOn(quiescence, 'assertClaudeTransferStopped').mockResolvedValue(undefined)
    expect(await assessLegacyBackendWindow(input)).toEqual({
      eligible: true,
      phase: 'backend-stop-entry-only',
      terminalStoppedVerified: true,
      dataMutationAllowed: false,
      nativeApiFenced: false,
      availableMs: null,
      requiredMs: 70000,
    })
  })
  it('rechecks pending work and freshness even after a verified terminal stop', async () => {
    vi.spyOn(quiescence, 'assertClaudeTransferStopped').mockResolvedValue(undefined)
    expect(
      await assessLegacyBackendWindow({
        ...input,
        observation: {
          ...observation,
          counts: { ...observation.counts, busySessions: 1 },
        },
      }),
    ).toEqual({ eligible: false, reason: 'WORK_ACTIVE' })
    vi.setSystemTime(budget.now + 5001)
    expect(
      await assessLegacyBackendWindow({
        ...input,
        budget: { ...budget, now: budget.now + 5001 },
      }),
    ).toEqual({ eligible: false, reason: 'STALE_OBSERVATION' })
  })
})
