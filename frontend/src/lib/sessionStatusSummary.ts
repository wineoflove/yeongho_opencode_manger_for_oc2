import type { SessionInfo, VoiceSessionStatus } from '@opencode-manager/shared/opencode'
import { t } from '@/i18n/translate'

/** Session duration: live while running, otherwise up to the recorded idle or last update time. */
export function sessionElapsedMs(session: SessionInfo, active: boolean, now: number): number {
  const end = active ? now : (session.time.idle ?? session.time.updated)
  return Math.max(0, end - session.time.created)
}

/** Localized label for the reported session status, falling back to running while a reply is still open. */
export function sessionStatusLabel(status: VoiceSessionStatus, active: boolean): string {
  if (status === 'retry') return t('Retrying')
  if (status === 'busy' || active) return t('Running')
  return t('Idle')
}
