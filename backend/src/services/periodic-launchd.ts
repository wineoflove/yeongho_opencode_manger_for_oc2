import { spawnSync } from 'node:child_process'
import { assertLaunchdDefinition, snapshotLaunchdDefinition } from './claude-launchd-definition'

export type PeriodicUnit = {
  readonly label: string
  readonly definition: string
  readonly sha256: string
}

export class PeriodicLaunchdError extends Error {
  constructor(
    readonly code:
      'INVALID_SCOPE' | 'STATE_UNKNOWN' | 'IDENTITY_CHANGED' | 'WORK_ACTIVE' | 'LAUNCHES_NOT_FENCED' | 'ACTION_FAILED',
  ) {
    super(code)
    this.name = 'PeriodicLaunchdError'
  }
}

export class PeriodicLaunchd {
  constructor(
    private readonly context: {
      readonly stateDirectory: string
      readonly assertLaunchesFenced?: (unit: PeriodicUnit) => Promise<void>
      readonly persist: (record: { readonly phase: string; readonly unit: PeriodicUnit }) => Promise<void>
    },
  ) {}

  private target(unit: PeriodicUnit) {
    if (
      !['io.wineoflove.ocm.backup-report', 'io.wineoflove.ocm.learning-cleanup'].includes(unit.label) &&
      !/^com\.aion\.ocm\.periodic-probe-[a-f0-9-]{36}$/.test(unit.label)
    )
      throw new PeriodicLaunchdError('INVALID_SCOPE')
    return `gui/${process.getuid?.()}/${unit.label}`
  }

  private command(args: readonly string[]) {
    const result = spawnSync('/bin/launchctl', [...args], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: { HOME: '/Users/yeonghokim', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })
    if (result.error || result.signal || result.status === null) throw new PeriodicLaunchdError('STATE_UNKNOWN')
    return result
  }

  async inspect(unit: PeriodicUnit) {
    const result = this.command(['print', this.target(unit)])
    if (
      result.status === 113 &&
      !result.stdout.trim() &&
      result.stderr.includes(`Could not find service "${unit.label}" in domain for user gui: ${process.getuid?.()}`)
    )
      return { state: 'absent' as const }
    if (result.status !== 0) throw new PeriodicLaunchdError('STATE_UNKNOWN')
    const path = /^\s*path = (.+)\s*$/m.exec(result.stdout)?.[1]?.trim()
    if (path !== unit.definition) throw new PeriodicLaunchdError('IDENTITY_CHANGED')
    await assertLaunchdDefinition(unit.definition, unit.sha256)
    const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1]
    if (pid) return { state: 'running' as const, pid: Number(pid) }
    const state = /^\s*state = (.+)\s*$/m.exec(result.stdout)?.[1]?.trim()
    if (state !== 'not running' && state !== 'waiting') throw new PeriodicLaunchdError('STATE_UNKNOWN')
    const exit = /^\s*last exit code = (\d+)\s*$/m.exec(result.stdout)?.[1]
    return {
      state: 'idle' as const,
      runs: Number(/^\s*runs = (\d+)\s*$/m.exec(result.stdout)?.[1] ?? 0),
      lastExitCode: exit === undefined ? undefined : Number(exit),
    }
  }

  async unregisterIdle(unit: PeriodicUnit) {
    const observed = await this.inspect(unit)
    if (observed.state === 'absent') return
    if (observed.state !== 'idle') throw new PeriodicLaunchdError('WORK_ACTIVE')
    if (!this.context.assertLaunchesFenced) throw new PeriodicLaunchdError('LAUNCHES_NOT_FENCED')
    await this.context.assertLaunchesFenced(unit)
    await this.context.persist({ phase: 'unregister-intent', unit })
    if ((await this.inspect(unit)).state !== 'idle') throw new PeriodicLaunchdError('WORK_ACTIVE')
    await this.context.assertLaunchesFenced(unit)
    if (this.command(['bootout', this.target(unit)]).status !== 0) throw new PeriodicLaunchdError('ACTION_FAILED')
    if ((await this.inspect(unit)).state !== 'absent') throw new PeriodicLaunchdError('STATE_UNKNOWN')
    await this.context.persist({ phase: 'unregistered', unit })
  }

  async register(unit: PeriodicUnit): Promise<PeriodicUnit> {
    if ((await this.inspect(unit)).state !== 'absent') throw new PeriodicLaunchdError('IDENTITY_CHANGED')
    await assertLaunchdDefinition(unit.definition, unit.sha256)
    const snapshot = await snapshotLaunchdDefinition(unit.definition, unit.label, this.context.stateDirectory)
    if (snapshot.sha256 !== unit.sha256) throw new PeriodicLaunchdError('IDENTITY_CHANGED')
    const installed = { ...unit, definition: snapshot.path }
    await this.context.persist({ phase: 'register-intent', unit: installed })
    if (this.command(['bootstrap', `gui/${process.getuid?.()}`, installed.definition]).status !== 0)
      throw new PeriodicLaunchdError('ACTION_FAILED')
    if ((await this.inspect(installed)).state === 'absent') throw new PeriodicLaunchdError('STATE_UNKNOWN')
    await this.context.persist({ phase: 'registered', unit: installed })
    return installed
  }
}
