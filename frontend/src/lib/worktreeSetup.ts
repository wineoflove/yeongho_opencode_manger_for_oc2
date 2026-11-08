import type { WorktreeSetupResult } from '@opencode-manager/shared/types'
import { showToast } from '@/lib/toast'
import { t } from '@/i18n/translate'

export function notifyWorktreeSetup(setup: WorktreeSetupResult | undefined): void {
  if (!setup) return
  if (setup.status === 'failed') {
    showToast.warning(t('Worktree setup failed to start'))
    return
  }
  if (setup.status === 'skipped' || (setup.status === 'started' && setup.repoCommandsSkipped)) {
    showToast.info(t('Repository setup commands were skipped until trusted in Actions'))
  }
}
