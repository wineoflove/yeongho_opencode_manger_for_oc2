import { z } from 'zod'

const legacyRules = z.array(
  z
    .object({
      permission: z.string().min(1),
      pattern: z.string(),
      action: z.enum(['allow', 'deny', 'ask']),
    })
    .strict(),
)

export class SessionPermissionMigrationError extends Error {
  constructor() {
    super('INVALID_LEGACY_PERMISSIONS')
    this.name = 'SessionPermissionMigrationError'
  }
}

function normalizeAction(action: string): string {
  switch (action) {
    case 'write':
    case 'patch':
    case 'apply_patch':
      return 'edit'
    case 'task':
      return 'subagent'
    case 'bash':
      return 'shell'
    default:
      return action
  }
}

export function planLegacySessionPermissions(value: unknown) {
  const parsed = legacyRules.safeParse(value)
  if (!parsed.success) throw new SessionPermissionMigrationError()
  const rules = parsed.data.map((rule) => ({
    action: normalizeAction(rule.permission),
    resource: rule.pattern,
    effect: rule.action,
  }))
  const groups = new Map<string, Set<string>>()
  const conflicts: string[] = []
  for (const rule of parsed.data) {
    if (rule.permission !== '*' && /[*?]/.test(rule.permission)) conflicts.push('wildcard-action-requires-review')
    const action = normalizeAction(rule.permission)
    const sources = groups.get(action) ?? new Set<string>()
    sources.add(rule.permission)
    groups.set(action, sources)
  }
  for (const [target, aliases] of groups) {
    if (aliases.size < 2) continue
    const signatures = [...aliases].map((alias) => {
      const relevant = parsed.data
        .filter((rule) => rule.permission === alias || rule.permission === '*')
        .map((rule) => ({ resource: rule.pattern, effect: rule.action }))
      return JSON.stringify(
        relevant.filter((rule, index) => index === 0 || JSON.stringify(rule) !== JSON.stringify(relevant[index - 1])),
      )
    })
    if (new Set(signatures).size !== 1) conflicts.push(`merged-action-requires-review:${target}`)
  }
  return { rules, conflicts: [...new Set(conflicts)] }
}
