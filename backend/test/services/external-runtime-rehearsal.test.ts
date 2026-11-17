import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'
import { rehearseExternalRuntime } from '../../../../bin/external-runtime-rehearsal.mjs'

const state = vi.hoisted(() => ({
  runtimeRunning: true,
  periodicHeld: false,
  dataAllowed: true,
  failRestore: false,
  failPlan: false,
  failReadiness: false,
}))
vi.mock('../../../../bin/operational-legacy-runtime.mjs', () => ({
  prepareOperationalLegacyRuntime: async () => ({
    context: {},
    assessDataPhase: async () => ({ eligible: state.dataAllowed }),
  }),
}))
vi.mock('../../../../bin/operational-periodic-control.mjs', () => ({
  operationalPeriodicControl: async () => {
    if (state.failPlan) throw new Error('synthetic-plan-rejected')
    return {
      steps: [
        {
          name: 'periodic-fixture',
          forward: async () => {
            state.periodicHeld = true
          },
          rollback: async () => {
            state.periodicHeld = false
          },
        },
      ],
      observe: async () => [],
    }
  },
}))
vi.mock('../../src/services/legacy-runtime-transition.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/legacy-runtime-transition')>()
  return {
    LegacyRuntimeTransitionError: original.LegacyRuntimeTransitionError,
    stopLegacyRuntime: async () => {
      if (state.failReadiness) throw new original.LegacyRuntimeTransitionError('runtime-preflight', 'verified')
      state.runtimeRunning = false
      return {}
    },
    restoreLegacyRuntime: async () => {
      if (state.failRestore) throw new Error('synthetic-restore-failure')
      state.runtimeRunning = true
    },
  }
})
beforeEach(() =>
  Object.assign(state, {
    runtimeRunning: true,
    periodicHeld: false,
    dataAllowed: true,
    failRestore: false,
    failPlan: false,
    failReadiness: false,
  }),
)

it.each(['normal', 'data-blocked', 'restore-failed', 'readiness-blocked', 'plan-blocked'])(
  'coordinates real journal restoration for %s',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-coordination-')))
    try {
      state.dataAllowed = mode !== 'data-blocked'
      state.failRestore = mode === 'restore-failed'
      state.failReadiness = mode === 'readiness-blocked'
      state.failPlan = mode === 'plan-blocked'
      const report: {
        runtime?: {
          failure?: { rollback: string }
          restored?: boolean
          mutationsStarted?: boolean
        }
      } = {}
      const result = rehearseExternalRuntime({
        stateDirectory: root,
        assertFrontendReadOnly: async () => {},
        report,
        save: async () => {},
        periodicPlan: '/synthetic/plan.json',
      })
      if (mode === 'normal') await result
      else await expect(result).rejects.toBeInstanceOf(Error)
      expect(state.runtimeRunning).toBe(mode !== 'restore-failed')
      expect(state.periodicHeld).toBe(mode === 'restore-failed')
      if (mode === 'plan-blocked') expect(report.runtime?.mutationsStarted).toBe(false)
      else if (mode !== 'normal')
        expect(report.runtime?.failure?.rollback).toBe(mode === 'restore-failed' ? 'unverified' : 'verified')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
