import { z } from 'zod'
import { assertClaudeTransferStopped } from './claude-transfer-quiescence'
import { assessLegacyMaintenanceWindow } from './legacy-maintenance-window'

const terminalSchema = z.object({
  label: z.string(),
  port: z.number().int().min(1024).max(65535),
  pids: z.array(z.number().int().min(2)).min(1),
  registered: z.literal(false),
})

export async function assessLegacyBackendWindow(input: {
  readonly observation: unknown
  readonly budget: unknown
  readonly stoppedTerminal: unknown
  readonly assertFrontendReadOnly: () => Promise<void>
}) {
  const terminal = terminalSchema.safeParse(input.stoppedTerminal)
  const budget = z.record(z.string(), z.unknown()).safeParse(input.budget)
  const observation = z.record(z.string(), z.unknown()).safeParse(input.observation)
  if (!terminal.success || !observation.success || !budget.success)
    return {
      eligible: false,
      reason: 'INVALID_STOPPED_TERMINAL_SCOPE',
    } as const
  const unit = terminal.data
  const production = unit.label === 'io.wineoflove.ocm.terminal' && unit.port === 5104
  const probe = /^com\.aion\.ocm\.maintenance-probe-[a-f0-9-]+\.frontend$/.test(unit.label)
  if ((!production && !probe) || [5003, 5551].includes(unit.port))
    return {
      eligible: false,
      reason: 'INVALID_STOPPED_TERMINAL_SCOPE',
    } as const
  try {
    await input.assertFrontendReadOnly()
  } catch {
    return { eligible: false, reason: 'FRONTEND_GATE_UNVERIFIED' } as const
  }
  try {
    await assertClaudeTransferStopped({
      processIDs: unit.pids,
      ports: [unit.port],
      launchdServices: [`gui/${process.getuid?.()}/${unit.label}`],
    })
  } catch {
    return { eligible: false, reason: 'TERMINAL_STOP_UNVERIFIED' } as const
  }
  const window = assessLegacyMaintenanceWindow(
    { ...observation.data, terminal: { ready: true, terminalSessions: 0 } },
    {
      ...budget.data,
      now: Date.now(),
    },
  )
  if (!window.eligible) return window
  return {
    eligible: true,
    phase: 'backend-stop-entry-only',
    terminalStoppedVerified: true,
    dataMutationAllowed: false,
    nativeApiFenced: false,
    availableMs: window.availableMs,
    requiredMs: window.requiredMs,
  } as const
}
