import type {
  ScheduleRun,
  ScheduleUsageTotals,
  ScheduleOverviewTotals,
  ScheduleOverviewJob,
} from '@opencode-manager/shared/schemas'
import { estimateUsageCost, type PriceTable } from './stats/pricing'

export function tokenCount(usage: Omit<ScheduleUsageTotals, 'messages'>): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export function aggregateUsage(runs: readonly ScheduleRun[], prices: PriceTable): ScheduleOverviewJob['usage'] {
  const totals: ScheduleUsageTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    messages: 0,
  }
  let runsWithUsage = 0
  let estimatedCost = 0
  let unpricedRuns = 0
  for (const run of runs) {
    const usage = run.usage
    if (!usage || usage.error !== null) continue
    runsWithUsage++
    const additional = usage.additional
    for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cost'] as const) {
      totals[key] += usage.totals[key] + (additional?.[key] ?? 0)
    }
    totals.messages += usage.totals.messages
    const byModel: Record<string, Omit<ScheduleUsageTotals, 'messages'>> = { ...usage.byModel }
    for (const [model, extra] of Object.entries(additional?.models ?? {})) {
      const existing = byModel[model]
      byModel[model] = {
        input: (existing?.input ?? 0) + extra.input,
        output: (existing?.output ?? 0) + extra.output,
        reasoning: (existing?.reasoning ?? 0) + extra.reasoning,
        cacheRead: (existing?.cacheRead ?? 0) + extra.cacheRead,
        cacheWrite: (existing?.cacheWrite ?? 0) + extra.cacheWrite,
        cost: (existing?.cost ?? 0) + extra.cost,
      }
    }
    const estimate = estimateUsageCost(byModel, prices)
    estimatedCost += estimate.estimatedCost
    if (estimate.unpricedModels > 0) unpricedRuns++
  }
  return runsWithUsage === 0
    ? null
    : {
        totals,
        runsWithUsage,
        perRunAvgTokens: tokenCount(totals) / runsWithUsage,
        recordedCost: totals.cost,
        estimatedCost,
        unpricedRuns,
      }
}

export function aggregateRuns(runs: readonly ScheduleRun[], prices: PriceTable): ScheduleOverviewTotals {
  const outcomes = { succeeded: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, unreported: 0, cancelled: 0 }
  const durations: number[] = []
  let terminal = 0
  let processed = 0
  for (const run of runs) {
    processed += run.outcomeReport?.processed ?? 0
    if (run.status === 'running') continue
    terminal++
    outcomes[run.outcome ?? 'unreported']++
    if (run.finishedAt !== null) durations.push(run.finishedAt - run.startedAt)
  }
  durations.sort((left, right) => left - right)
  const usage = aggregateUsage(runs, prices)
  return {
    runs: runs.length,
    terminal,
    outcomes,
    successRate: terminal ? outcomes.succeeded / terminal : null,
    avgDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    p90DurationMs: durations[Math.ceil(durations.length * 0.9) - 1] ?? null,
    processed,
    runsWithUsage: usage?.runsWithUsage ?? 0,
    tokens: usage ? tokenCount(usage.totals) : 0,
    recordedCost: usage?.recordedCost ?? 0,
    estimatedCost: usage?.estimatedCost ?? null,
  }
}

export function maxConcurrent(
  runs: readonly ScheduleRun[],
  range: { readonly from: number; readonly to: number },
  now: number,
): number {
  const events: { at: number; delta: number }[] = []
  for (const run of runs) {
    const start = Math.max(run.startedAt, range.from)
    const end = Math.min(run.finishedAt ?? now, range.to)
    if (start < end) events.push({ at: start, delta: 1 }, { at: end, delta: -1 })
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta)
  let active = 0
  let maximum = 0
  for (const event of events) {
    active += event.delta
    maximum = Math.max(maximum, active)
  }
  return maximum
}
