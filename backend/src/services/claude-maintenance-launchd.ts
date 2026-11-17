import { spawnSync } from 'node:child_process'
import { MaintenanceLaunchdScope } from './maintenance-launchd-scope'
import { observeExistingLaunchd } from './observe-existing-launchd'
import type { MaintenanceLaunchdCheckpoint, MaintenanceLaunchdUnit } from './maintenance-launchd-types'
export type { MaintenanceLaunchdCheckpoint, MaintenanceLaunchdUnit } from './maintenance-launchd-types'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assertClaudeTransferStopped,
  assertOwnedRuntimeStopped,
  captureClaudeProcessTree,
  captureProcessIdentities,
  listenerProcessIDs,
  survivingIdentities,
} from './claude-transfer-quiescence'
import {
  assertLaunchdDefinition,
  boundedLaunchdHealth,
  MaintenanceLaunchdError,
  snapshotLaunchdDefinition,
} from './claude-launchd-definition'

export { MaintenanceLaunchdError } from './claude-launchd-definition'

export class MaintenanceLaunchd {
  private readonly scope: MaintenanceLaunchdScope
  constructor(
    private readonly context: {
      readonly domain: string
      readonly home: string
      readonly stateDirectory: string
      readonly persist: (checkpoint: MaintenanceLaunchdCheckpoint) => Promise<void>
      readonly signal?: AbortSignal
      readonly healthTimeoutMs?: number
      readonly claudeProxy?: boolean
      readonly legacyRuntimeTargets?: readonly {
        readonly label: string
        readonly port: number
      }[]
    },
  ) {
    this.scope = new MaintenanceLaunchdScope(context)
  }

  private target(unit: MaintenanceLaunchdUnit) {
    return this.scope.target(unit)
  }

  recovery(): MaintenanceLaunchd {
    return new MaintenanceLaunchd({
      domain: this.context.domain,
      home: this.context.home,
      stateDirectory: this.context.stateDirectory,
      persist: this.context.persist,
      healthTimeoutMs: this.context.healthTimeoutMs,
      legacyRuntimeTargets: this.scope.legacyRuntimeTargets,
      claudeProxy: this.scope.claudeProxy,
    })
  }

  private command(args: readonly string[]) {
    const result = spawnSync('/bin/launchctl', [...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.context.home },
    })
    if (result.error || result.signal || result.status === null) throw new MaintenanceLaunchdError('STATE_UNKNOWN')
    return result
  }

  private assertPortFree(unit: MaintenanceLaunchdUnit) {
    const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${unit.port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.error || result.signal || result.status !== 1 || result.stdout.trim() || result.stderr.trim())
      throw new MaintenanceLaunchdError('STATE_UNKNOWN')
  }

  private inspect(unit: MaintenanceLaunchdUnit) {
    const result = this.command(['print', this.target(unit)])
    if (
      result.status === 113 &&
      !result.stdout.trim() &&
      result.stderr.includes(`Could not find service "${unit.label}" in domain for user gui: ${process.getuid?.()}`)
    )
      return { present: false } as const
    if (result.status !== 0) throw new MaintenanceLaunchdError('STATE_UNKNOWN')
    const definition = /^\s*path = (.+)\s*$/m.exec(result.stdout)?.[1]?.trim()
    if (!unit.definition || definition !== unit.definition) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1]
    if (unit.expectedPID !== undefined && Number(pid) !== unit.expectedPID)
      throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    if (
      unit.expectedStarted !== undefined &&
      captureProcessIdentities([Number(pid)])[0]?.started !== unit.expectedStarted
    )
      throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    if (pid) unit.pids = [...new Set([...unit.pids, ...captureClaudeProcessTree(Number(pid))])]
    return { present: true, pid: pid ? Number(pid) : undefined } as const
  }

  private async checkpoint(unit: MaintenanceLaunchdUnit, phase: MaintenanceLaunchdCheckpoint['phase']) {
    try {
      await this.context.persist({
        phase,
        recordedAt: Date.now(),
        unit: { ...unit, pids: [...unit.pids] },
      })
    } catch {
      throw new MaintenanceLaunchdError('STATE_PERSIST_FAILED')
    }
  }

  async observeExisting(
    target: { readonly label: string; readonly port: number },
    expected: {
      readonly definition: string
      readonly sha256: string
      readonly pid: number
      readonly activeDefinition?: string
    },
  ): Promise<MaintenanceLaunchdUnit> {
    if (!Number.isInteger(expected.pid) || expected.pid < 2) throw new MaintenanceLaunchdError('INVALID_SCOPE')
    this.target({ ...target, pids: [], registered: false })
    return observeExistingLaunchd(target, expected, {
      stateDirectory: this.context.stateDirectory,
      inspect: (unit) => this.inspect(unit),
      checkpoint: (unit) => this.checkpoint(unit, 'observed-existing'),
    })
  }

  async assertRunning(unit: MaintenanceLaunchdUnit): Promise<void> {
    if (!unit.registered) throw new MaintenanceLaunchdError('INVALID_SCOPE')
    const first = this.inspect(unit)
    if (!first.present || !first.pid) throw new MaintenanceLaunchdError('STATE_UNKNOWN')
    await assertLaunchdDefinition(unit.definition, unit.definitionSha256)
    const listeners = listenerProcessIDs(unit.port)
    if (listeners.length !== 1 || listeners[0] !== first.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    const second = this.inspect(unit)
    if (!second.present || second.pid !== first.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    await this.checkpoint(unit, 'observed')
  }

  async boot(
    unit: MaintenanceLaunchdUnit,
    definition: string,
    check: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<void> {
    if (this.context.signal?.aborted) throw new MaintenanceLaunchdError('CANCELLED')
    if (this.inspect(unit).present) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
    this.assertPortFree(unit)
    const snapshot = await snapshotLaunchdDefinition(definition, unit.label, this.context.stateDirectory)
    const previous = {
      definition: unit.definition,
      definitionSha256: unit.definitionSha256,
      bootstrapState: unit.bootstrapState,
      expectedPID: unit.expectedPID,
      expectedStarted: unit.expectedStarted,
    }
    unit.definition = snapshot.path
    unit.definitionSha256 = snapshot.sha256
    delete unit.expectedPID
    delete unit.expectedStarted
    unit.bootstrapState = 'intent'
    unit.registered = true
    try {
      await this.checkpoint(unit, 'bootstrap-intent')
      await assertLaunchdDefinition(unit.definition, unit.definitionSha256)
      if (this.context.signal?.aborted) throw new MaintenanceLaunchdError('CANCELLED')
    } catch (error) {
      unit.registered = false
      Object.assign(unit, previous)
      throw error
    }
    const started = this.command(['bootstrap', this.context.domain, snapshot.path])
    if (started.status !== 0) {
      unit.bootstrapState = 'rejected'
      await this.checkpoint(unit, 'bootstrap-rejected')
      throw new MaintenanceLaunchdError('BOOTSTRAP_FAILED')
    }
    unit.bootstrapState = 'accepted'
    await this.checkpoint(unit, 'bootstrap-accepted')
    const timeout = AbortSignal.timeout(this.context.healthTimeoutMs ?? 20000)
    const signal = this.context.signal ? AbortSignal.any([timeout, this.context.signal]) : timeout
    let recordedPids = ''
    for (;;) {
      if (signal.aborted)
        throw new MaintenanceLaunchdError(this.context.signal?.aborted ? 'CANCELLED' : 'HEALTH_TIMEOUT')
      const state = this.inspect(unit)
      if (state.present && state.pid && unit.expectedPID === undefined) {
        const identity = captureProcessIdentities([state.pid])[0]
        if (!identity) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
        unit.expectedPID = identity.pid
        unit.expectedStarted = identity.started
      }
      if (recordedPids !== JSON.stringify(unit.pids)) {
        await this.checkpoint(unit, 'observed')
        recordedPids = JSON.stringify(unit.pids)
      }
      if (state.present && state.pid && (await boundedLaunchdHealth(check, signal))) {
        const ready = this.inspect(unit)
        if (!ready.present) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
        await this.checkpoint(unit, 'ready')
        return
      }
      await delay(100)
    }
  }

  private async stopOwner(unit: MaintenanceLaunchdUnit): Promise<void> {
    const ports = [...new Set([unit.port, ...(unit.ownedPorts ?? [])])]
    if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || [5003, 5551].includes(port)))
      throw new MaintenanceLaunchdError('INVALID_SCOPE')
    const state = this.inspect(unit)
    if (state.present) {
      if (!state.pid || !unit.definition || !unit.definitionSha256) throw new MaintenanceLaunchdError('STATE_UNKNOWN')
      await assertLaunchdDefinition(unit.definition, unit.definitionSha256)
      const owners = new Set([state.pid, ...ports.flatMap((port) => listenerProcessIDs(port))])
      const required = captureProcessIdentities([...owners])
      if (required.length !== owners.size) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
      unit.stopRequired = required
      await this.checkpoint(unit, 'stop-intent')
      const current = this.inspect(unit)
      if (!current.present || current.pid !== state.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
      if (survivingIdentities(required).length !== required.length)
        throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
      if (this.command(['bootout', this.target(unit)]).status !== 0) throw new MaintenanceLaunchdError('BOOTOUT_FAILED')
    }
    const required = unit.stopRequired
    if (!required?.length) throw new MaintenanceLaunchdError('PID_UNOBSERVED')
    const deadline = Date.now() + 20000
    for (;;) {
      try {
        await assertOwnedRuntimeStopped({
          identities: required,
          ports,
          launchdServices: [this.target(unit)],
        })
        break
      } catch (error) {
        if (!(error instanceof Error) || Date.now() >= deadline) throw error
        await delay(100)
      }
    }
    unit.survivingDescendants = captureProcessIdentities(unit.pids).length
    await this.checkpoint({ ...unit, registered: false }, 'stopped')
    unit.registered = false
  }

  async stop(unit: MaintenanceLaunchdUnit): Promise<void> {
    if (!unit.registered) return
    if (unit.stopScope === 'owner') return this.stopOwner(unit)
    const state = this.inspect(unit)
    if (!state.present && !unit.pids.length && unit.bootstrapState === 'rejected') {
      this.assertPortFree(unit)
      await this.checkpoint({ ...unit, registered: false }, 'stopped')
      unit.registered = false
      return
    }
    if (state.present) {
      await assertLaunchdDefinition(unit.definition, unit.definitionSha256)
      await this.checkpoint(unit, 'stop-intent')
      const current = this.inspect(unit)
      if (!current.present || current.pid !== state.pid) throw new MaintenanceLaunchdError('IDENTITY_CHANGED')
      if (this.command(['bootout', this.target(unit)]).status !== 0) throw new MaintenanceLaunchdError('BOOTOUT_FAILED')
    }
    if (!unit.pids.length) throw new MaintenanceLaunchdError('PID_UNOBSERVED')
    const deadline = Date.now() + 20000
    for (;;) {
      try {
        await assertClaudeTransferStopped({
          processIDs: unit.pids,
          ports: [unit.port],
          launchdServices: [this.target(unit)],
        })
        break
      } catch (error) {
        if (!(error instanceof Error) || Date.now() >= deadline) throw error
        await delay(100)
      }
    }
    await this.checkpoint({ ...unit, registered: false }, 'stopped')
    unit.registered = false
  }
}
