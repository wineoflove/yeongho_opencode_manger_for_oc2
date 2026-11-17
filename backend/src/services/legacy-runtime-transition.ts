import type { MaintenanceLaunchd, MaintenanceLaunchdUnit } from './claude-maintenance-launchd'
import { assertLaunchdDefinition, snapshotLaunchdDefinition } from './claude-launchd-definition'
import { assertOwnedRuntimeStopped } from './claude-transfer-quiescence'

type Definition = {
  readonly source: string
  readonly snapshot: string
  readonly sha256: string
}
export type LegacyRuntimeRestorePoint = {
  readonly backend: Definition
  readonly terminal: Definition
  readonly backendStopRequested: boolean
  readonly terminalStopRequested: boolean
}
type Context = {
  readonly lifecycle: MaintenanceLaunchd
  readonly backend: MaintenanceLaunchdUnit
  readonly terminal: MaintenanceLaunchdUnit
  readonly nativePort: number
  readonly stateDirectory: string
  readonly assertEntryReady: () => Promise<void>
  readonly assertBackendIdle: () => Promise<void>
  readonly assertOriginalArtifacts: () => Promise<void>
  readonly health: {
    readonly backend: (signal: AbortSignal) => Promise<boolean>
    readonly terminal: (signal: AbortSignal) => Promise<boolean>
  }
  readonly persist: (record: {
    readonly phase: string
    readonly restore: LegacyRuntimeRestorePoint
    readonly recordedAt: number
  }) => Promise<void>
}
export class LegacyRuntimeTransitionError extends Error {
  constructor(
    readonly phase: string,
    readonly rollback: 'verified' | 'failed',
  ) {
    super('LEGACY_RUNTIME_TRANSITION_FAILED')
    this.name = 'LegacyRuntimeTransitionError'
  }
}
async function checkpoint(context: Context, restore: LegacyRuntimeRestorePoint, phase: string) {
  await context.persist({
    phase,
    restore: { ...restore },
    recordedAt: Date.now(),
  })
}
async function verifyDefinitions(restore: LegacyRuntimeRestorePoint) {
  for (const definition of [restore.backend, restore.terminal]) {
    await assertLaunchdDefinition(definition.source, definition.sha256)
    await assertLaunchdDefinition(definition.snapshot, definition.sha256)
  }
}
export async function restoreLegacyRuntime(context: Context, restore: LegacyRuntimeRestorePoint) {
  await context.assertOriginalArtifacts()
  await verifyDefinitions(restore)
  const recovery = context.lifecycle.recovery()
  await checkpoint(context, restore, 'runtime-restore-intent')
  if (restore.backendStopRequested) {
    await recovery.stop(context.backend)
    await context.assertOriginalArtifacts()
    await recovery.boot(context.backend, restore.backend.snapshot, context.health.backend)
  }
  if (restore.terminalStopRequested) {
    await recovery.stop(context.terminal)
    await context.assertOriginalArtifacts()
    await recovery.boot(context.terminal, restore.terminal.snapshot, context.health.terminal)
  }
  await checkpoint(context, restore, 'original-runtime-restored')
}
export async function stopLegacyRuntime(context: Context): Promise<LegacyRuntimeRestorePoint> {
  const { backend, terminal, lifecycle } = context
  const production =
    backend.label === 'io.wineoflove.ocm.backend' &&
    backend.port === 5101 &&
    terminal.label === 'io.wineoflove.ocm.terminal' &&
    terminal.port === 5104 &&
    context.nativePort === 5102
  const prefix = /^com\.aion\.ocm\.maintenance-probe-([a-f0-9-]+)\.gateway$/.exec(backend.label)?.[1]
  const probe = prefix !== undefined && terminal.label === `com.aion.ocm.maintenance-probe-${prefix}.frontend`
  if (
    (!production && !probe) ||
    !backend.registered ||
    !terminal.registered ||
    backend.expectedPID === undefined ||
    terminal.expectedPID === undefined ||
    !backend.definition ||
    !terminal.definition ||
    !backend.definitionSha256 ||
    !terminal.definitionSha256 ||
    !Number.isInteger(context.nativePort) ||
    context.nativePort < 1024 ||
    context.nativePort > 65535 ||
    [5003, 5551].includes(context.nativePort) ||
    new Set([backend.port, terminal.port, context.nativePort]).size !== 3 ||
    backend.stopScope !== 'owner' ||
    terminal.stopScope !== 'owner' ||
    !backend.ownedPorts?.includes(context.nativePort)
  )
    throw new LegacyRuntimeTransitionError('invalid-scope', 'verified')
  const definitions: Definition[] = []
  try {
    await context.assertEntryReady()
    await context.assertOriginalArtifacts()
    for (const unit of [backend, terminal]) {
      if (!unit.definition || !unit.definitionSha256)
        throw new LegacyRuntimeTransitionError('invalid-scope', 'verified')
      await assertLaunchdDefinition(unit.definition, unit.definitionSha256)
      const saved = await snapshotLaunchdDefinition(unit.definition, unit.label, context.stateDirectory)
      if (saved.sha256 !== unit.definitionSha256)
        throw new LegacyRuntimeTransitionError('definition-changed', 'verified')
      definitions.push({
        source: unit.definition,
        snapshot: saved.path,
        sha256: saved.sha256,
      })
    }
  } catch (error) {
    if (error instanceof LegacyRuntimeTransitionError) throw error
    throw new LegacyRuntimeTransitionError('runtime-preflight', 'verified')
  }
  const [backendDefinition, terminalDefinition] = definitions
  if (!backendDefinition || !terminalDefinition) throw new LegacyRuntimeTransitionError('invalid-scope', 'verified')
  const restore = {
    backend: backendDefinition,
    terminal: terminalDefinition,
    backendStopRequested: false,
    terminalStopRequested: false,
  }
  let phase = 'runtime-prepared'
  try {
    await checkpoint(context, restore, phase)
    await context.assertEntryReady()
    phase = 'terminal-stop'
    await checkpoint(context, { ...restore, terminalStopRequested: true }, phase)
    restore.terminalStopRequested = true
    await lifecycle.stop(terminal)
    phase = 'backend-idle-recheck'
    await checkpoint(context, restore, phase)
    await context.assertBackendIdle()
    await context.assertOriginalArtifacts()
    phase = 'backend-stop'
    await checkpoint(context, { ...restore, backendStopRequested: true }, phase)
    restore.backendStopRequested = true
    await lifecycle.stop(backend)
    phase = 'runtime-stopped'
    await assertOwnedRuntimeStopped({
      identities: [...(backend.stopRequired ?? []), ...(terminal.stopRequired ?? [])],
      ports: [backend.port, terminal.port, context.nativePort],
      launchdServices: [`gui/${process.getuid?.()}/${backend.label}`, `gui/${process.getuid?.()}/${terminal.label}`],
    })
    await checkpoint(context, restore, phase)
    return restore
  } catch {
    let rollback: 'verified' | 'failed' = 'verified'
    try {
      if (restore.backendStopRequested || restore.terminalStopRequested) await restoreLegacyRuntime(context, restore)
    } catch {
      rollback = 'failed'
    }
    throw new LegacyRuntimeTransitionError(phase, rollback)
  }
}
