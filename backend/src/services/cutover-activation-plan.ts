import { stoppedDataCutoverSteps } from './stopped-data-cutover-steps'
import { runtimeFilesCutoverSteps } from './runtime-files-cutover-steps'
import type { releaseRuntimeCutoverSteps } from './release-runtime-cutover-steps'
import { serviceCutoverStep } from './cutover-service-step'
import type { CutoverStep } from './cutover-step-runner'
import { executePinnedCutover } from './execute-pinned-cutover'

export function executeCutoverActivation(input: {
  readonly activation: Parameters<typeof cutoverActivationPlan>[0]
  readonly execution: Omit<Parameters<typeof executePinnedCutover>[0], 'steps'>
}) {
  return executePinnedCutover({
    ...input.execution,
    steps: cutoverActivationPlan(input.activation),
  })
}

export function cutoverActivationPlan(input: {
  readonly data: Parameters<typeof stoppedDataCutoverSteps>[0]
  readonly files: Parameters<typeof runtimeFilesCutoverSteps>[0]
  readonly runtime: Parameters<typeof releaseRuntimeCutoverSteps>[0]
  readonly schedules: CutoverStep
  readonly postflight: () => Promise<void>
}): readonly CutoverStep[] {
  if (input.schedules.name !== 'update-learning-schedule-commands') throw new Error('LEARNING_SCHEDULE_STEP_REQUIRED')
  return [
    {
      name: 'validate-activation-preconditions',
      forward: input.files.assertForwardReady,
      rollback: async () => {},
    },
    ...stoppedDataCutoverSteps(input.data),
    ...runtimeFilesCutoverSteps(input.files),
    input.schedules,
    serviceCutoverStep(input.runtime.proxy),
    serviceCutoverStep(input.runtime.backend),
    {
      name: 'operational-postflight',
      forward: input.postflight,
      rollback: async () => {},
    },
  ]
}
