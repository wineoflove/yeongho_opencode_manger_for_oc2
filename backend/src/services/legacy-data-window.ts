import type { MaintenanceLaunchdUnit } from './claude-maintenance-launchd'
import { assertClaudeTransferStopped, assertDatabaseFilesUnheld } from './claude-transfer-quiescence'

type DataWindow =
  { readonly eligible: true; readonly surviving: 0 } | { readonly eligible: false; readonly reason: string }

export async function assessLegacyDataWindow(input: {
  readonly units: readonly MaintenanceLaunchdUnit[]
  readonly databases: readonly string[]
}): Promise<DataWindow> {
  if (!input.units.length || input.units.some((unit) => unit.registered))
    return { eligible: false, reason: 'RUNTIME_NOT_STOPPED' }
  if (input.units.some((unit) => unit.survivingDescendants !== 0))
    return { eligible: false, reason: 'DESCENDANTS_UNVERIFIED' }
  try {
    for (const unit of input.units) {
      await assertClaudeTransferStopped({
        processIDs: unit.pids,
        ports: [...new Set([unit.port, ...(unit.ownedPorts ?? [])])],
        launchdServices: [`gui/${process.getuid?.()}/${unit.label}`],
      })
    }
    await assertDatabaseFilesUnheld(input.databases)
    return { eligible: true, surviving: 0 }
  } catch (error) {
    return {
      eligible: false,
      reason: error instanceof Error && 'code' in error ? String(error.code) : 'DATA_WINDOW_UNVERIFIED',
    }
  }
}
