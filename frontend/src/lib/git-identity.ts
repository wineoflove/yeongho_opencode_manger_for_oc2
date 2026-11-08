import { t } from '@/i18n/translate'
export interface GitIdentityValues {
  name?: string | null
  email?: string | null
}

/**
 * Formats a git identity as `Name <email>`, using explicit placeholders when a
 * part is missing and a single fallback when nothing is configured.
 */
export function formatGitIdentity(identity: GitIdentityValues): string {
  const name = identity.name
  const email = identity.email
  if (!name && !email) return t('Not configured')
  return `${name || t('No name')} <${email || t('No email')}>`
}
