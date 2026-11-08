import { Button } from '@/components/ui/button'
import { Loader2, ArrowUpCircle, RotateCcw, History } from 'lucide-react'
import { useServerHealth } from '@/hooks/useServerHealth'
import { useOpenCodeServerActions } from '@/hooks/useOpenCodeServerActions'
import { RestartServerDialog } from './RestartServerDialog'
import { t } from '@/i18n/translate'
import { RepoErrorText } from '@/components/repo/RepoErrorText'

interface ServerHealthStatusProps {
  onOpenVersionDialog?: () => void
}

export function ServerHealthStatus({ onOpenVersionDialog }: ServerHealthStatusProps) {
  const { data: health } = useServerHealth()
  const {
    restartServerMutation,
    upgradeOpenCodeMutation,
    confirmOpen,
    setConfirmOpen,
    activeSessionCount,
    requestRestart,
    confirmRestart,
    performUpgrade,
  } = useOpenCodeServerActions()

  if (!health) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('Loading server status...')}</span>
      </div>
    )
  }

  const isUnhealthy = health.opencode !== 'healthy'

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className={`h-3 w-3 rounded-full ${isUnhealthy ? 'bg-destructive animate-pulse' : 'bg-success'}`} />
          <p className="font-medium text-sm">
            {t('Server Status: {status}', { status: isUnhealthy ? t('Unhealthy') : t('Healthy') })}
          </p>
          {health.error && (
            <p className="text-xs text-destructive">
              <RepoErrorText message={health.error} />
            </p>
          )}
          {health.opencodeVersion && (
            <p className="text-xs text-muted-foreground">
              OpenCode v{health.opencodeVersion}
            </p>
          )}
          {health.opencodeManagerVersion && (
            <p className="text-xs text-muted-foreground">
              {t('Manager v{version}', { version: health.opencodeManagerVersion })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-11 sm:h-8"
            onClick={performUpgrade}
            disabled={upgradeOpenCodeMutation.isPending}
          >
            {upgradeOpenCodeMutation.isPending ? (
              <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3 w-3 sm:h-4 sm:w-4" />
            )}
            <span className="text-xs sm:text-sm">{t('Update')}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-11 sm:h-8"
            onClick={requestRestart}
            disabled={restartServerMutation.isPending}
          >
            {restartServerMutation.isPending ? (
              <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3 sm:h-4 sm:w-4" />
            )}
            <span className="text-xs sm:text-sm">{t('Restart')}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-11 sm:h-8"
            onClick={onOpenVersionDialog}
          >
            <History className="h-3 w-3 sm:h-4 sm:w-4" />
            <span className="text-xs sm:text-sm">{t('Versions')}</span>
          </Button>
        </div>
      </div>
      <RestartServerDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        activeSessionCount={activeSessionCount}
        isRestarting={restartServerMutation.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirmRestart}
      />
    </>
  )
}
