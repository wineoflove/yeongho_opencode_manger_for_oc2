import type { ProcessIdentity } from './claude-transfer-quiescence'

export type MaintenanceLaunchdUnit = {
  readonly label: string
  readonly port: number
  pids: number[]
  registered: boolean
  definition?: string
  definitionSha256?: string
  sourceDefinition?: string
  sourceDefinitionSha256?: string
  expectedPID?: number
  expectedStarted?: string
  bootstrapState?: 'intent' | 'accepted' | 'rejected'
  stopScope?: 'owner'
  ownedPorts?: readonly number[]
  stopRequired?: readonly ProcessIdentity[]
  survivingDescendants?: number
}

export type MaintenanceLaunchdCheckpoint = {
  readonly phase:
    | 'bootstrap-intent'
    | 'bootstrap-rejected'
    | 'bootstrap-accepted'
    | 'observed'
    | 'observed-existing'
    | 'ready'
    | 'stop-intent'
    | 'stopped'
  readonly recordedAt: number
  readonly unit: Readonly<MaintenanceLaunchdUnit>
}
