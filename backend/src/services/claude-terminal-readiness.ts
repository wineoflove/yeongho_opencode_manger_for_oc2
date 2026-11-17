import { z } from 'zod'

const terminalStatusSchema = z.object({
  schemaVersion: z.literal(1),
  ready: z.boolean(),
  counts: z.object({ terminalSessions: z.number().int().nonnegative() }),
  blockers: z.array(z.string()),
})

export function assessClaudeTerminalReadiness(response: { readonly status: number; readonly body: unknown }) {
  const parsed = terminalStatusSchema.safeParse(response.body)
  if (response.status !== 200 || !parsed.success)
    return {
      ready: false,
      terminalSessions: null,
      reason: 'TERMINAL_STATUS_UNVERIFIED',
    } as const
  const { ready, counts, blockers } = parsed.data
  if (counts.terminalSessions > 0)
    return {
      ready: false,
      terminalSessions: counts.terminalSessions,
      reason: 'TERMINALS_PRESENT',
    } as const
  if (!ready || blockers.length)
    return {
      ready: false,
      terminalSessions: null,
      reason: 'TERMINAL_STATUS_UNVERIFIED',
    } as const
  return { ready: true, terminalSessions: 0, reason: null } as const
}
