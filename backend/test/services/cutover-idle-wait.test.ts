import { afterEach, expect, it, vi } from 'vitest'
import { waitForCutoverEntry } from '../../src/services/cutover-idle-wait'

afterEach(() => vi.restoreAllMocks())
function receipt(busy = false) {
  return {
    budget: {
      maximumObservationAgeMs: 5000,
      executionBudgetMs: 60000,
      safetyMarginMs: 10000,
    },
    observation: {
      observedAt: Date.now(),
      counts: {
        expectedDirectories: 1,
        idleDirectories: 1,
        busyDirectories: 0,
        unknownDirectories: 0,
        busySessions: busy ? 1 : 0,
        enabledSchedules: 0,
        activeSchedules: 0,
        activeRecovery: 0,
      },
      terminal: { ready: true, terminalSessions: 0 },
      recoveryStates: [],
      inventoryBlockers: [],
      schedules: [],
    },
  }
}
const limits = () => ({
  maximumWaitMs: 10000,
  pollMs: 1,
  signal: new AbortController().signal,
})

it('rechecks active work and only returns the later idle observation', async () => {
  let attempts = 0
  const result = await waitForCutoverEntry({
    ...limits(),
    observe: async () => receipt(++attempts === 1),
  })
  expect(result.outcome).toBe('ready')
  expect(result.attempts).toBe(2)
  if (result.outcome !== 'ready') throw new Error('not-ready')
  expect(result.entry.backendStopAllowed).toBe(false)
  expect(result.entry.dataMutationAllowed).toBe(false)
})

it('does not accept an idle result that arrives after the waiting deadline', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000)
  const result = await waitForCutoverEntry({
    ...limits(),
    observe: async () => {
      clock.mockReturnValue(1020000)
      return receipt()
    },
  })
  expect(result).toEqual({ outcome: 'timeout', attempts: 1 })
})

it('does not retry missing inventory or expose an observation error body', async () => {
  const observe = vi.fn(async () => {
    throw new Error('synthetic-secret-error')
  })
  expect(await waitForCutoverEntry({ ...limits(), observe })).toEqual({
    outcome: 'blocked',
    reason: 'OBSERVATION_FAILED',
    attempts: 0,
  })
  expect(observe).toHaveBeenCalledTimes(1)
  expect(
    await waitForCutoverEntry({
      ...limits(),
      observe: async () => ({ ...receipt(), observation: {} }),
    }),
  ).toEqual({ outcome: 'blocked', reason: 'INVALID_OBSERVATION', attempts: 1 })
})

it('cancels before observation and after a pending observation returns', async () => {
  const controller = new AbortController()
  controller.abort()
  const observe = vi.fn(async () => receipt())
  expect(
    (
      await waitForCutoverEntry({
        ...limits(),
        signal: controller.signal,
        observe,
      })
    ).outcome,
  ).toBe('blocked')
  expect(observe).not.toHaveBeenCalled()
  const next = new AbortController()
  expect(
    await waitForCutoverEntry({
      ...limits(),
      signal: next.signal,
      observe: async () => {
        next.abort()
        return receipt()
      },
    }),
  ).toEqual({ outcome: 'blocked', reason: 'CANCELLED', attempts: 1 })
})
