import { assertLaunchdDefinition, MaintenanceLaunchdError } from './claude-launchd-definition'
import type { MaintenanceLaunchd, MaintenanceLaunchdUnit } from './claude-maintenance-launchd'
import type { CutoverStep } from './cutover-step-runner'

export function serviceCutoverStep(input: {
  readonly name: string
  readonly lifecycle: MaintenanceLaunchd
  readonly unit: MaintenanceLaunchdUnit
  readonly definition: string
  readonly sha256: string
  readonly health: (signal: AbortSignal) => Promise<boolean>
  readonly assertBeforeBoot?: () => Promise<void>
}): CutoverStep {
  return {
    name: input.name,
    forward: async () => {
      if (input.unit.registered) throw new MaintenanceLaunchdError('INVALID_SCOPE')
      await assertLaunchdDefinition(input.definition, input.sha256)
      await input.assertBeforeBoot?.()
      await input.lifecycle.boot(input.unit, input.definition, input.health)
    },
    rollback: async () => {
      await input.lifecycle.recovery().stop(input.unit)
    },
  }
}
