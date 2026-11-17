import { setTimeout as delay } from 'node:timers/promises'
import { assessLegacyMaintenanceWindow } from './legacy-maintenance-window'

type Observation = {
  readonly observation: unknown
  readonly budget: {
    readonly maximumObservationAgeMs: number
    readonly executionBudgetMs: number
    readonly safetyMarginMs: number
  }
}

export class CutoverIdleWaitError extends Error {
  constructor() {
    super('INVALID_CUTOVER_WAIT_BUDGET')
    this.name = 'CutoverIdleWaitError'
  }
}

export async function waitForCutoverEntry(input: {
  readonly observe: () => Promise<Observation>
  readonly maximumWaitMs: number
  readonly pollMs: number
  readonly signal: AbortSignal
}) {
  if (
    !Number.isSafeInteger(input.maximumWaitMs) ||
    input.maximumWaitMs < 1 ||
    input.maximumWaitMs > 3600000 ||
    !Number.isSafeInteger(input.pollMs) ||
    input.pollMs < 1 ||
    input.pollMs > 30000
  )
    throw new CutoverIdleWaitError()
  const deadline = Date.now() + input.maximumWaitMs
  let attempts = 0
  for (;;) {
    if (input.signal.aborted) return { outcome: 'blocked' as const, reason: 'CANCELLED', attempts }
    if (Date.now() >= deadline) return { outcome: 'timeout' as const, attempts }
    let receipt: Observation
    try {
      receipt = await input.observe()
    } catch {
      return {
        outcome: 'blocked' as const,
        reason: 'OBSERVATION_FAILED',
        attempts,
      }
    }
    attempts += 1
    if (input.signal.aborted) return { outcome: 'blocked' as const, reason: 'CANCELLED', attempts }
    if (Date.now() >= deadline) return { outcome: 'timeout' as const, attempts }
    const entry = assessLegacyMaintenanceWindow(receipt.observation, {
      ...receipt.budget,
      now: Date.now(),
    })
    if (entry.eligible) return { outcome: 'ready' as const, entry, receipt, attempts }
    if (entry.reason !== 'WORK_ACTIVE') return { outcome: 'blocked' as const, reason: entry.reason, attempts }
    try {
      await delay(Math.min(input.pollMs, Math.max(0, deadline - Date.now())), undefined, { signal: input.signal })
    } catch {
      return { outcome: 'blocked' as const, reason: 'CANCELLED', attempts }
    }
  }
}
