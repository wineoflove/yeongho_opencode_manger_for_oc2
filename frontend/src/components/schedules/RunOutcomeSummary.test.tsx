import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ScheduleRunUsage, ScheduleUsageTotals } from '@opencode-manager/shared/schemas'
import type { ScheduleRun } from '@opencode-manager/shared/types'
import { setLocale } from '@/i18n/locale'
import { t } from '@/i18n/translate'
import { RunOutcomeSummary } from './RunOutcomeSummary'

const MODEL_NOTE =
  'By model: stored assistant responses only. The total also includes title generation, compaction and reverted messages.'

const run: ScheduleRun = {
  id: 7,
  jobId: 3,
  repoId: 1,
  triggerSource: 'schedule',
  status: 'completed',
  startedAt: 0,
  finishedAt: 1,
  viewedAt: null,
  createdAt: 0,
  sessionId: 'ses_root',
  sessionTitle: null,
  logText: null,
  responseText: null,
  errorText: null,
  runBranch: null,
  commitHash: null,
  worktreePath: null,
}

function usageTotals(input: number, output: number, cost: number): ScheduleUsageTotals {
  return { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost, messages: 1 }
}

const failed: ScheduleRunUsage = {
  computedAt: 1,
  sessions: 0,
  totals: usageTotals(0, 0, 0),
  byModel: {},
  additional: null,
  error: 'SCHEDULE_USAGE_CAPTURE_FAILED',
}

const partial: ScheduleRunUsage = {
  computedAt: 1,
  sessions: 2,
  totals: usageTotals(1200, 300, 0.0123),
  byModel: { 'openai/gpt-a': usageTotals(700, 200, 0.008) },
  additional: null,
  error: 'USAGE_SESSION_UNAVAILABLE',
}

const complete: ScheduleRunUsage = {
  computedAt: 1,
  sessions: 3,
  totals: usageTotals(10000, 2345, 0.4321),
  byModel: {
    'openai/gpt-a': usageTotals(3000, 1000, 0.2),
    'anthropic/claude-b': usageTotals(800, 200, 0.05),
  },
  additional: { input: 500, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  error: null,
}

function renderUsage(usage: ScheduleRunUsage) {
  render(<RunOutcomeSummary run={{ ...run, usage }} />)
  return screen.getByRole('region', { name: t('Outcome') })
}

describe.each(['en', 'ko'] as const)('RunOutcomeSummary usage coverage (%s)', (locale) => {
  beforeEach(() => setLocale(locale))

  it('shows a failed snapshot as unavailable instead of a measured zero', () => {
    const summary = renderUsage(failed)

    expect(summary).toHaveTextContent(t('Usage unavailable'))
    expect(summary).not.toHaveTextContent('$0')
    expect(summary).not.toHaveTextContent('SCHEDULE_USAGE_CAPTURE_FAILED')
  })

  it('labels a partial snapshot incomplete and keeps its measured totals', () => {
    const summary = renderUsage(partial)

    expect(summary).toHaveTextContent(t('Usage incomplete'))
    expect(summary).toHaveTextContent('1,500')
    expect(summary).toHaveTextContent('$0.0123')
    expect(summary).not.toHaveTextContent('USAGE_SESSION_UNAVAILABLE')
  })

  it('keeps session-tree totals apart from the assistant-only model rows', () => {
    const summary = renderUsage(complete)

    expect(summary).toHaveTextContent('12,345')
    expect(summary).toHaveTextContent('$0.4321')
    expect(summary).toHaveTextContent(t(MODEL_NOTE))
    expect(summary).not.toHaveTextContent(t('Usage incomplete'))
  })
})
