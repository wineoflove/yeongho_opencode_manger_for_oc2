import { setTimeout as delay } from 'node:timers/promises'
import type { PeriodicLaunchd, PeriodicUnit } from './periodic-launchd'
import { PeriodicLaunchdError } from './periodic-launchd'
import type { CutoverStep } from './cutover-step-runner'

export function periodicSuspensionStep(input: {
  readonly name: 'suspend-backup-report' | 'suspend-learning-cleanup'
  readonly originallyRegistered: boolean
  readonly restoreDefinition?: {
    readonly path: string
    readonly sha256: string
  }
  readonly lifecycle: PeriodicLaunchd
  readonly unit: () => PeriodicUnit
  readonly maximumWaitMs: number
  readonly assertFenced: (unit: PeriodicUnit) => Promise<void>
  readonly signal?: AbortSignal
}): CutoverStep {
  if (!Number.isSafeInteger(input.maximumWaitMs) || input.maximumWaitMs < 1 || input.maximumWaitMs > 3600000)
    throw new PeriodicLaunchdError('INVALID_SCOPE')
  return {
    name: input.name,
    forward: async () => {
      const deadline = Date.now() + input.maximumWaitMs
      for (;;) {
        if (input.signal?.aborted || Date.now() >= deadline) throw new PeriodicLaunchdError('WORK_ACTIVE')
        const unit = input.unit()
        await input.assertFenced(unit)
        const observed = await input.lifecycle.inspect(unit)
        if (!input.originallyRegistered && observed.state !== 'absent')
          throw new PeriodicLaunchdError('IDENTITY_CHANGED')
        if (input.signal?.aborted || Date.now() >= deadline) throw new PeriodicLaunchdError('WORK_ACTIVE')
        switch (observed.state) {
          case 'absent':
            return
          case 'idle':
            try {
              await input.lifecycle.unregisterIdle(unit)
              return
            } catch (error) {
              if (!(error instanceof PeriodicLaunchdError && error.code === 'WORK_ACTIVE')) throw error
            }
            break
          case 'running':
            break
        }
        await delay(50)
      }
    },
    rollback: async () => {
      const unit = input.unit()
      const observed = await input.lifecycle.inspect(unit)
      if (!input.originallyRegistered && observed.state !== 'absent') throw new PeriodicLaunchdError('IDENTITY_CHANGED')
      if (input.originallyRegistered && observed.state === 'absent') {
        const restored = input.restoreDefinition
          ? {
              ...unit,
              definition: input.restoreDefinition.path,
              sha256: input.restoreDefinition.sha256,
            }
          : unit
        await input.assertFenced(restored)
        await input.lifecycle.register(restored)
      } else if (observed.state !== 'absent') await input.assertFenced(unit)
    },
  }
}
