import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'
import { activateExternalRuntime } from '../../../../bin/external-runtime-rehearsal.mjs'
import { completeExternalPeriodic } from '../../../../bin/external-postcommit-periodic.mjs'

const state = vi.hoisted(() => ({
  legacyRestored: false,
  failPeriodic: false,
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: `pid = ${process.pid}\n`,
    stderr: '',
  })),
}))
vi.mock('../../../../bin/operational-legacy-runtime.mjs', () => ({
  prepareOperationalLegacyRuntime: async () => ({
    context: {},
    assessDataPhase: async () => ({ eligible: true }),
  }),
}))
vi.mock('../../../../bin/operational-periodic-control.mjs', () => ({
  operationalPeriodicControl: async () => ({
    steps: [],
    observe: async () => [],
  }),
}))
vi.mock('../../src/services/legacy-runtime-transition.ts', async (original) => ({
  ...(await original<typeof import('../../src/services/legacy-runtime-transition')>()),
  stopLegacyRuntime: async () => ({}),
  restoreLegacyRuntime: async () => {
    state.legacyRestored = true
  },
}))
vi.mock('../../../../bin/execute-operational-activation.mjs', () => ({
  executeOperationalActivation: async () => ({ phase: 'committed' }),
}))
vi.mock('../../../../bin/periodic-v2-batch.mjs', () => ({
  activatePeriodicBatch: async () => {
    if (state.failPeriodic) throw new Error('fixture-periodic-failure')
    return { results: [], registered: 0, executionVerified: false }
  },
}))
beforeEach(() => {
  state.legacyRestored = false
  state.failPeriodic = false
})

const activation = {
  stateDirectory: '/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-fixture',
  prepare: async () => ({
    learningTransition: {
      path: '/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-fixture/learning-transition.json',
    },
  }),
  descriptor: async () => ({
    path: '/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-fixture/operational-recovery.json',
    sha256: 'a'.repeat(64),
  }),
}

it('preserves the committed runtime when saving the final outer journal status fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'external-finalization-')))
  const report: {
    runtime?: {
      activationCommitted?: boolean
      periodicActivationPending?: boolean
      failure?: unknown
    }
  } = {}
  try {
    await expect(
      activateExternalRuntime({
        externalUnit: 'com.aion.ocm.cutover-00000000-0000-4000-8000-000000000001',
        stateDirectory: root,
        assertFrontendReadOnly: async () => {},
        report,
        save: async () => {
          if (report.runtime?.activationCommitted) throw new Error('fixture-save-failure')
        },
        periodicPlan: '/fixture',
        activation,
        periodicActivation: {
          prepare: async () => [],
          assertReady: async () => {},
        },
      }),
    ).rejects.toMatchObject({
      name: 'PostCommitPeriodicError',
      activationCommitted: true,
      reportSaved: false,
      runtimeJournalClosed: true,
    })
    expect(state.legacyRestored).toBe(false)
    expect(report.runtime?.failure).toBeUndefined()
    expect(report.runtime?.periodicActivationPending).toBe(true)
  } finally {
    await rm(root, { recursive: true })
  }
})

it('clears the current periodic failure when the same committed report succeeds on retry', async () => {
  const report = {
    runtime: {
      activationCommitted: true,
      periodicActivationPending: true,
      periodicFailure: 'POSTCOMMIT_PERIODIC_PENDING',
    },
  }
  const input = {
    result: { phase: 'committed' },
    externalUnit: 'fixture',
    activation,
    periodicActivation: {
      prepare: async () => [],
      assertReady: async () => {},
    },
    report,
    save: async () => {},
  }
  state.failPeriodic = true
  await expect(completeExternalPeriodic(input)).rejects.toMatchObject({
    activationCommitted: true,
  })
  state.failPeriodic = false
  await completeExternalPeriodic(input)
  expect(report.runtime.periodicActivationPending).toBe(false)
  expect(report.runtime).not.toHaveProperty('periodicFailure')
  expect(state.legacyRestored).toBe(false)
})
