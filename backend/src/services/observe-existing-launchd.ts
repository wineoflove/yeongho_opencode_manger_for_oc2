import { spawnSync } from 'node:child_process'
import {
  assertLaunchdDefinition,
  MaintenanceLaunchdError,
  snapshotLaunchdDefinition,
} from './claude-launchd-definition'
import type { MaintenanceLaunchdUnit } from './maintenance-launchd-types'
import { captureProcessIdentities } from './claude-transfer-quiescence'

export async function observeExistingLaunchd(
  target: { readonly label: string; readonly port: number },
  expected: {
    readonly definition: string
    readonly sha256: string
    readonly pid: number
    readonly activeDefinition?: string
  },
  context: {
    readonly stateDirectory: string
    readonly inspect: (unit: MaintenanceLaunchdUnit) => {
      readonly present: boolean
      readonly pid?: number
    }
    readonly checkpoint: (unit: MaintenanceLaunchdUnit) => Promise<void>
  },
): Promise<MaintenanceLaunchdUnit> {
  await assertLaunchdDefinition(expected.definition, expected.sha256)
  const activeDefinition = expected.activeDefinition ?? expected.definition
  await assertLaunchdDefinition(activeDefinition, expected.sha256)
  const snapshot = await snapshotLaunchdDefinition(activeDefinition, target.label, context.stateDirectory)
  if (snapshot.sha256 !== expected.sha256) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  const unit: MaintenanceLaunchdUnit = {
    ...target,
    pids: [],
    registered: true,
    definition: activeDefinition,
    definitionSha256: expected.sha256,
    sourceDefinition: expected.definition,
    sourceDefinitionSha256: expected.sha256,
    bootstrapState: 'accepted',
    expectedPID: expected.pid,
  }
  const first = context.inspect(unit)
  if (!first.present || first.pid !== expected.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  const identity = captureProcessIdentities([expected.pid])[0]
  if (!identity || identity.pid !== expected.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  unit.expectedStarted = identity.started
  const listener = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${unit.port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (listener.error || listener.signal || listener.status !== 0 || listener.stderr.trim())
    throw new MaintenanceLaunchdError('STATE_UNKNOWN')
  const listeners = new Set(listener.stdout.trim().split('\n'))
  if (listeners.size !== 1 || !listeners.has(String(expected.pid)))
    throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  await assertLaunchdDefinition(expected.definition, expected.sha256)
  await assertLaunchdDefinition(activeDefinition, expected.sha256)
  const second = context.inspect(unit)
  if (!second.present || second.pid !== first.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
  await context.checkpoint(unit)
  return unit
}
