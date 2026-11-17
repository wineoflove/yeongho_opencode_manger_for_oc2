import { describe, expect, it } from 'vitest'
import { assessClaudeCutoverWindow } from '../../src/services/claude-cutover-window'

const budget = {
  now: 10000,
  maximumObservationAgeMs: 1000,
  executionBudgetMs: 5000,
  safetyMarginMs: 2000,
}
const observation = {
  observedAt: 9500,
  enabledSchedules: 1,
  activeSchedules: 0,
  schedules: [{ jobId: 2, nextRunAt: 18000 }],
}

describe('read-only cutover time budget', () => {
  it('reports time sufficiency without claiming admission fencing', () => {
    expect(assessClaudeCutoverWindow(observation, budget)).toEqual({
      sufficient: true,
      availableMs: 8000,
      requiredMs: 7000,
      admissionFenced: false,
    })
  })
  it.each([8999, 10001])('rejects stale or future observations: %s', (observedAt) => {
    expect(assessClaudeCutoverWindow({ ...observation, observedAt }, budget)).toEqual({
      sufficient: false,
      reason: 'STALE_OBSERVATION',
    })
  })
  it.each([0, 10000, 16999, 17000])('rejects overdue and insufficient windows: %s', (nextRunAt) => {
    expect(assessClaudeCutoverWindow({ ...observation, schedules: [{ jobId: 2, nextRunAt }] }, budget)).toEqual({
      sufficient: false,
      reason: 'INSUFFICIENT_TIME',
    })
  })
  it('rejects incomplete and duplicate inventories', () => {
    for (const schedules of [[], [observation.schedules[0], observation.schedules[0]]]) {
      expect(assessClaudeCutoverWindow({ ...observation, enabledSchedules: 2, schedules }, budget)).toEqual({
        sufficient: false,
        reason: 'INCOMPLETE_INVENTORY',
      })
    }
  })
  it('rejects unknown execution time and active runs', () => {
    expect(assessClaudeCutoverWindow({ ...observation, schedules: [{ jobId: 2, nextRunAt: null }] }, budget)).toEqual({
      sufficient: false,
      reason: 'RUN_TIME_UNKNOWN',
    })
    expect(assessClaudeCutoverWindow({ ...observation, activeSchedules: 1 }, budget)).toEqual({
      sufficient: false,
      reason: 'WORK_ACTIVE',
    })
  })
  it('handles no enabled schedules without inventing a measured deadline', () => {
    expect(assessClaudeCutoverWindow({ ...observation, enabledSchedules: 0, schedules: [] }, budget)).toEqual({
      sufficient: true,
      availableMs: null,
      requiredMs: 7000,
      admissionFenced: false,
    })
  })
  it.each([0, -1, NaN, Infinity])('rejects invalid execution budgets: %s', (executionBudgetMs) => {
    expect(
      assessClaudeCutoverWindow(observation, {
        ...budget,
        executionBudgetMs,
      }),
    ).toEqual({ sufficient: false, reason: 'INVALID_INPUT' })
  })
})
