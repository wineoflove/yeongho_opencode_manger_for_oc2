import { serviceCutoverStep } from './cutover-service-step'
import { promoteFrontendFromMaintenance } from './claude-frontend-transition'
import { assertLaunchdDefinition } from './claude-launchd-definition'
import type { FrontendMaintenanceTransition, FrontendRestorePoint } from './claude-frontend-transition'
import type { CutoverStep } from './cutover-step-runner'

type Service = Parameters<typeof serviceCutoverStep>[0]

export function releaseRuntimeCutoverSteps(input: {
  readonly proxy: Service
  readonly backend: Service
  readonly frontend: Parameters<typeof frontendPromotionCutoverStep>[0]
}): readonly CutoverStep[] {
  return [
    serviceCutoverStep(input.proxy),
    serviceCutoverStep(input.backend),
    frontendPromotionCutoverStep(input.frontend),
  ]
}

export function frontendPromotionCutoverStep(input: {
  readonly context: FrontendMaintenanceTransition
  readonly restore: FrontendRestorePoint
  readonly release: Parameters<typeof promoteFrontendFromMaintenance>[2]
  readonly assertBeforePromotion?: () => Promise<void>
  readonly maintenance: {
    readonly frontend: { readonly path: string; readonly sha256: string }
    readonly gateway: { readonly path: string; readonly sha256: string }
  }
}): CutoverStep {
  const maintenance = structuredClone(input.maintenance)
  const assertDemotionReady = async () => {
    await assertLaunchdDefinition(maintenance.frontend.path, maintenance.frontend.sha256)
    await assertLaunchdDefinition(maintenance.gateway.path, maintenance.gateway.sha256)
  }
  return {
    name: 'promote-release-frontend',
    forward: async () => {
      await input.assertBeforePromotion?.()
      await assertDemotionReady()
      await promoteFrontendFromMaintenance(input.context, input.restore, input.release)
    },
    rollback: async () => {
      const { context } = input
      await assertDemotionReady()
      const recovery = context.lifecycle.recovery()
      if (!context.gateway.registered)
        await recovery.boot(context.gateway, maintenance.gateway.path, context.probes.gateway)
      await recovery.stop(context.frontend)
      await recovery.boot(context.frontend, maintenance.frontend.path, context.probes.maintenance)
      await context.persist({
        phase: 'rollback-maintenance-active',
        restore: input.restore,
        frontend: { ...context.frontend, pids: [...context.frontend.pids] },
        gateway: { ...context.gateway, pids: [...context.gateway.pids] },
        recordedAt: Date.now(),
      })
    },
  }
}
