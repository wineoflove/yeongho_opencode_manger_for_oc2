import { z } from 'zod'
import { CutoverPublicationUncertainError } from './cutover-publication-error'

const journalSchema = z
  .object({
    version: z.literal(1),
    plan: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1),
    phase: z.enum(['forward', 'rollback', 'committed', 'restored']),
    started: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    undone: z.number().int().nonnegative(),
  })
  .strict()

export type CutoverJournal = Readonly<z.infer<typeof journalSchema>>
export type CutoverStep = {
  readonly name: string
  readonly forward: () => Promise<void>
  readonly rollback: () => Promise<void>
}
type Runner = {
  readonly steps: readonly CutoverStep[]
  readonly persist: (state: CutoverJournal) => Promise<void>
}

export class CutoverStepError extends Error {
  constructor(
    readonly step: string | undefined,
    readonly rollback: 'verified' | 'unverified',
  ) {
    super('CUTOVER_STEP_FAILED')
    this.name = 'CutoverStepError'
  }
}

export class CutoverJournalError extends Error {
  constructor() {
    super('CUTOVER_JOURNAL_INVALID')
    this.name = 'CutoverJournalError'
  }
}

export function parseJournal(input: unknown, steps: readonly CutoverStep[]): CutoverJournal {
  const result = journalSchema.safeParse(input)
  if (!result.success) throw new CutoverJournalError()
  const state = result.data
  if (
    state.plan.length !== steps.length ||
    new Set(state.plan).size !== state.plan.length ||
    state.plan.some((name, index) => steps[index]?.name !== name) ||
    state.started > steps.length ||
    state.completed > state.started ||
    state.started - state.completed > 1 ||
    state.undone > state.started ||
    (state.phase === 'forward' && state.undone !== 0) ||
    (state.phase === 'committed' && (state.completed !== steps.length || state.undone !== 0)) ||
    (state.phase === 'restored' && state.undone !== state.started)
  )
    throw new CutoverJournalError()
  return state
}

export async function recoverCutoverSteps(input: Runner & { readonly journal: unknown }): Promise<CutoverJournal> {
  let state = parseJournal(input.journal, input.steps)
  switch (state.phase) {
    case 'committed':
    case 'restored':
      return state
    case 'forward':
    case 'rollback':
      break
  }
  while (state.undone < state.started) {
    const step = input.steps[state.started - state.undone - 1]
    if (!step) throw new CutoverJournalError()
    try {
      state = { ...state, phase: 'rollback' }
      await input.persist(state)
      await step.rollback()
      state = { ...state, undone: state.undone + 1 }
      await input.persist(state)
    } catch {
      throw new CutoverStepError(step.name, 'unverified')
    }
  }
  state = { ...state, phase: 'restored' }
  try {
    await input.persist(state)
  } catch {
    throw new CutoverStepError(undefined, 'unverified')
  }
  return state
}

export async function runCutoverSteps(input: Runner & { readonly until?: string }): Promise<CutoverJournal> {
  let state = parseJournal(
    {
      version: 1,
      plan: input.steps.map((step) => step.name),
      phase: 'forward',
      started: 0,
      completed: 0,
      undone: 0,
    },
    input.steps,
  )
  if (input.until !== undefined && !state.plan.includes(input.until)) throw new CutoverJournalError()
  let active: string | undefined
  try {
    for (const step of input.steps) {
      active = step.name
      const intent = { ...state, started: state.started + 1 }
      await input.persist(intent)
      state = intent
      await step.forward()
      state = { ...state, completed: state.completed + 1 }
      await input.persist(state)
      if (input.until === step.name) break
    }
    if (input.until === undefined) {
      const committed = { ...state, phase: 'committed' as const }
      await input.persist(committed)
      return committed
    }
  } catch (error) {
    if (error instanceof CutoverPublicationUncertainError) throw error
    await recoverCutoverSteps({ ...input, journal: state })
    throw new CutoverStepError(active, 'verified')
  }
  return recoverCutoverSteps({ ...input, journal: state })
}
