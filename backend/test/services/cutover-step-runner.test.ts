import { describe, expect, it } from 'vitest'
import { recoverCutoverSteps, runCutoverSteps, type CutoverJournal } from '../../src/services/cutover-step-runner'

function fixture(failing = -1, rollbackFailure = -1) {
  const active = new Set<string>()
  const undone: string[] = []
  const journal: CutoverJournal[] = []
  const steps = ['database', 'credentials', 'runtime'].map((name, index) => ({
    name,
    forward: async () => {
      active.add(name)
      if (index === failing) throw new Error('synthetic-sensitive-error')
    },
    rollback: async () => {
      if (index === rollbackFailure) throw new Error('rollback-failed')
      active.delete(name)
      undone.push(name)
    },
  }))
  return {
    active,
    undone,
    journal,
    steps,
    persist: async (state: CutoverJournal) => {
      journal.push(state)
    },
  }
}

describe('cutover step compensation', () => {
  it.each([0, 1, 2])('reverts even a partially applied failing step %i', async (index) => {
    const f = fixture(index)
    await expect(runCutoverSteps(f)).rejects.toMatchObject({
      rollback: 'verified',
      message: 'CUTOVER_STEP_FAILED',
    })
    expect(f.active.size).toBe(0)
    expect(f.undone).toEqual(['database', 'credentials', 'runtime'].slice(0, index + 1).reverse())
    expect(f.journal.at(-1)?.phase).toBe('restored')
  })
  it('does not restart earlier components after credential rollback fails', async () => {
    const f = fixture(2, 1)
    await expect(runCutoverSteps(f)).rejects.toMatchObject({
      step: 'credentials',
      rollback: 'unverified',
    })
    expect(f.active).toEqual(new Set(['database', 'credentials']))
    expect(f.undone).toEqual(['runtime'])
  })
  it('recovers a persisted intent without a completion record', async () => {
    const f = fixture()
    await f.steps[0]?.forward()
    await f.steps[1]?.forward()
    const result = await recoverCutoverSteps({
      ...f,
      journal: {
        version: 1,
        plan: ['database', 'credentials', 'runtime'],
        phase: 'forward',
        started: 2,
        completed: 1,
        undone: 0,
      },
    })
    expect(result.phase).toBe('restored')
    expect(f.active.size).toBe(0)
    expect(f.undone).toEqual(['credentials', 'database'])
  })
  it('rolls back an applied step if its completion record cannot be saved', async () => {
    const f = fixture()
    await expect(
      runCutoverSteps({
        ...f,
        persist: async (state) => {
          if (state.phase === 'forward' && state.completed === 1) throw new Error('disk-failure')
          await f.persist(state)
        },
      }),
    ).rejects.toMatchObject({ rollback: 'verified' })
    expect(f.active.size).toBe(0)
    expect(f.undone).toEqual(['database'])
  })
  it('never invokes a step whose intent could not be persisted', async () => {
    const f = fixture()
    await expect(
      runCutoverSteps({
        ...f,
        persist: async (state) => {
          if (state.phase === 'forward' && state.started === 1) throw new Error('disk-failure')
          await f.persist(state)
        },
      }),
    ).rejects.toMatchObject({ rollback: 'verified' })
    expect(f.active.size).toBe(0)
    expect(f.undone).toEqual([])
  })
  it('restores changes when the requested rehearsal ceiling is reached', async () => {
    const f = fixture()
    expect((await runCutoverSteps({ ...f, until: 'credentials' })).phase).toBe('restored')
    expect(f.active.size).toBe(0)
    expect(f.undone).toEqual(['credentials', 'database'])
  })
  it('does not undo a committed plan when recovery is requested', async () => {
    const f = fixture()
    const journal = await runCutoverSteps(f)
    expect((await recoverCutoverSteps({ ...f, journal })).phase).toBe('committed')
    expect(f.active.size).toBe(3)
    expect(f.undone).toEqual([])
  })
  it('rejects incomplete journal data instead of compensating guessed steps', async () => {
    const f = fixture()
    await expect(recoverCutoverSteps({ ...f, journal: { phase: 'rollback' } })).rejects.toThrow(
      'CUTOVER_JOURNAL_INVALID',
    )
    expect(f.undone).toEqual([])
  })
})
