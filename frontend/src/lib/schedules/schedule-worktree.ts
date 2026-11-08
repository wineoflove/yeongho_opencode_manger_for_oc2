import { t } from '@/i18n/translate'

export function formatScheduleWorktreeLabel(runId: number | null): string {
  return runId === null ? t('Shared worktree') : t('Run #{id}', { id: runId })
}
