import type { MaintenanceLaunchd, MaintenanceLaunchdUnit } from './claude-maintenance-launchd'
import {
  assertLaunchdDefinition,
  MaintenanceLaunchdError,
  snapshotLaunchdDefinition,
} from './claude-launchd-definition'

type Probe = (signal: AbortSignal) => Promise<boolean>
export type FrontendRestorePoint = {
  readonly source: string
  readonly snapshot: string
  readonly sha256: string
}
export type FrontendTransitionRecord = {
  readonly phase: string
  readonly restore: FrontendRestorePoint
  readonly frontend: Readonly<MaintenanceLaunchdUnit>
  readonly gateway: Readonly<MaintenanceLaunchdUnit>
  readonly recordedAt: number
}
export type FrontendMaintenanceTransition = {
  readonly lifecycle: MaintenanceLaunchd
  readonly frontend: MaintenanceLaunchdUnit
  readonly gateway: MaintenanceLaunchdUnit
  readonly definitions: {
    readonly frontend: string
    readonly gateway: string
    readonly stateDirectory: string
  }
  readonly probes: {
    readonly normal: Probe
    readonly maintenance: Probe
    readonly gateway: Probe
  }
  readonly assertReady: () => Promise<void>
  readonly persist: (record: FrontendTransitionRecord) => Promise<void>
}

export class FrontendTransitionError extends Error {
  constructor(
    readonly phase: string,
    readonly primaryCode: string,
    readonly rollback: 'verified' | 'failed',
  ) {
    super('FRONTEND_TRANSITION_FAILED')
    this.name = 'FrontendTransitionError'
  }
}

export class FrontendPromotionError extends Error {
  constructor(
    readonly phase: string,
    readonly primaryCode: string,
  ) {
    super('FRONTEND_PROMOTION_FAILED')
    this.name = 'FrontendPromotionError'
  }
}

export async function promoteFrontendFromMaintenance(
  context: FrontendMaintenanceTransition,
  restore: FrontendRestorePoint,
  release: {
    readonly definition: string
    readonly sha256: string
    readonly probe: Probe
  },
) {
  if (!context.frontend.registered || !context.gateway.registered) throw new MaintenanceLaunchdError('INVALID_SCOPE')
  await assertLaunchdDefinition(restore.snapshot, restore.sha256)
  await assertLaunchdDefinition(release.definition, release.sha256)
  const snapshot = await snapshotLaunchdDefinition(
    release.definition,
    context.frontend.label,
    context.definitions.stateDirectory,
  )
  if (snapshot.sha256 !== release.sha256) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  let phase = 'promotion-intent'
  try {
    await checkpoint(context, restore, phase)
    phase = 'maintenance-frontend-stop'
    await context.lifecycle.stop(context.frontend)
    phase = 'release-frontend-start'
    await context.lifecycle.boot(context.frontend, snapshot.path, release.probe)
    await checkpoint(context, restore, 'release-frontend-ready')
    phase = 'maintenance-gateway-stop'
    await context.lifecycle.stop(context.gateway)
    await checkpoint(context, restore, 'frontend-promoted')
  } catch (error) {
    throw new FrontendPromotionError(
      phase,
      error instanceof MaintenanceLaunchdError ? error.code : 'PROMOTION_STEP_FAILED',
    )
  }
}

async function checkpoint(context: FrontendMaintenanceTransition, restore: FrontendRestorePoint, phase: string) {
  await context.persist({
    phase,
    restore,
    frontend: { ...context.frontend, pids: [...context.frontend.pids] },
    gateway: { ...context.gateway, pids: [...context.gateway.pids] },
    recordedAt: Date.now(),
  })
}

export async function restoreFrontendMaintenance(
  context: FrontendMaintenanceTransition,
  restore: FrontendRestorePoint,
) {
  await assertLaunchdDefinition(restore.source, restore.sha256)
  await assertLaunchdDefinition(restore.snapshot, restore.sha256)
  await checkpoint(context, restore, 'rollback-intent')
  const recovery = context.lifecycle.recovery()
  await recovery.stop(context.frontend)
  await recovery.boot(context.frontend, restore.snapshot, context.probes.normal)
  await checkpoint(context, restore, 'normal-frontend-restored')
  await recovery.stop(context.gateway)
  await checkpoint(context, restore, 'rollback-complete')
}

export async function enterFrontendMaintenance(context: FrontendMaintenanceTransition): Promise<FrontendRestorePoint> {
  const { frontend, gateway, lifecycle, definitions, probes } = context
  if (
    !frontend.registered ||
    frontend.expectedPID === undefined ||
    !frontend.definition ||
    !frontend.definitionSha256 ||
    gateway.registered ||
    frontend.label === gateway.label ||
    frontend.port === gateway.port
  )
    throw new MaintenanceLaunchdError('INVALID_SCOPE')
  await context.assertReady()
  await assertLaunchdDefinition(frontend.definition, frontend.definitionSha256)
  const original = await snapshotLaunchdDefinition(frontend.definition, frontend.label, definitions.stateDirectory)
  if (original.sha256 !== frontend.definitionSha256) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  const restore = {
    source: frontend.definition,
    snapshot: original.path,
    sha256: original.sha256,
  }
  const frontendDefinition = await snapshotLaunchdDefinition(
    definitions.frontend,
    frontend.label,
    definitions.stateDirectory,
  )
  const gatewayDefinition = await snapshotLaunchdDefinition(
    definitions.gateway,
    gateway.label,
    definitions.stateDirectory,
  )
  let phase = 'prepared'
  let frontendStopRequested = false
  try {
    await checkpoint(context, restore, phase)
    phase = 'gateway-start'
    await lifecycle.boot(gateway, gatewayDefinition.path, probes.gateway)
    await checkpoint(context, restore, 'gateway-ready')
    phase = 'readiness-recheck'
    await context.assertReady()
    phase = 'original-frontend-stop'
    frontendStopRequested = true
    await lifecycle.stop(frontend)
    await checkpoint(context, restore, 'original-frontend-stopped')
    phase = 'maintenance-frontend-start'
    await lifecycle.boot(frontend, frontendDefinition.path, probes.maintenance)
    await checkpoint(context, restore, 'maintenance-active')
    return restore
  } catch (error) {
    let rollback: 'verified' | 'failed' = 'verified'
    try {
      if (frontendStopRequested) await restoreFrontendMaintenance(context, restore)
      else {
        await lifecycle.stop(gateway)
        await checkpoint(context, restore, 'original-frontend-untouched')
      }
    } catch {
      rollback = 'failed'
    }
    throw new FrontendTransitionError(
      phase,
      error instanceof MaintenanceLaunchdError ? error.code : 'TRANSITION_STEP_FAILED',
      rollback,
    )
  }
}
