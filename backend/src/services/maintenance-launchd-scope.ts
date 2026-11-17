import { isAbsolute } from 'node:path'
import { MaintenanceLaunchdError } from './claude-launchd-definition'

type Target = { readonly label: string; readonly port: number }
export type MaintenanceScopeOptions = {
  readonly domain: string
  readonly home: string
  readonly stateDirectory: string
  readonly healthTimeoutMs?: number
  readonly legacyRuntimeTargets?: readonly Target[]
  readonly claudeProxy?: boolean
}

export class MaintenanceLaunchdScope {
  readonly legacyRuntimeTargets: readonly Target[]
  readonly claudeProxy: boolean

  constructor(options: MaintenanceScopeOptions) {
    if (
      options.domain !== `gui/${process.getuid?.()}` ||
      !isAbsolute(options.home) ||
      !isAbsolute(options.stateDirectory) ||
      (options.healthTimeoutMs !== undefined &&
        (!Number.isInteger(options.healthTimeoutMs) ||
          options.healthTimeoutMs < 1 ||
          options.healthTimeoutMs > 20000)) ||
      (options.claudeProxy !== undefined && typeof options.claudeProxy !== 'boolean')
    )
      throw new MaintenanceLaunchdError('INVALID_SCOPE')
    const targets = options.legacyRuntimeTargets ?? []
    if (
      targets.some(
        ({ label, port }) =>
          !(
            (label === 'io.wineoflove.ocm.backend' && port === 5101) ||
            (label === 'io.wineoflove.ocm.terminal' && port === 5104)
          ),
      ) ||
      new Set(targets.map(({ label }) => label)).size !== targets.length
    )
      throw new MaintenanceLaunchdError('INVALID_SCOPE')
    this.legacyRuntimeTargets = Object.freeze(targets.map((target) => Object.freeze({ ...target })))
    this.claudeProxy = options.claudeProxy === true
  }

  target(unit: Target): string {
    const existing =
      /^(?:io\.wineoflove\.ocm\.frontend|com\.aion\.ocm\.maintenance-ingress|com\.aion\.ocm\.maintenance-probe-[a-f0-9-]+\.(?:gateway|frontend))$/.test(
        unit.label,
      )
    const legacy = this.legacyRuntimeTargets.some(({ label, port }) => label === unit.label && port === unit.port)
    const proxy = this.claudeProxy && unit.label === 'com.aion.ocm.claude-proxy' && unit.port === 5117
    if (
      !(existing || legacy || proxy) ||
      !Number.isInteger(unit.port) ||
      unit.port < 1024 ||
      unit.port > 65535 ||
      [5003, 5551].includes(unit.port)
    )
      throw new MaintenanceLaunchdError('INVALID_SCOPE')
    return `gui/${process.getuid?.()}/${unit.label}`
  }
}
