import type { ProviderPoolResponse } from '@opencode-manager/shared/schemas'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n/translate'

export function ProviderPoolStatus({
  data,
  failed,
  loading,
  refresh,
}: {
  readonly data: ProviderPoolResponse | undefined
  readonly failed: boolean
  readonly loading: boolean
  readonly refresh: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-2 border-b border-border py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">
        {failed ? (
          <p role="alert">{t('Could not load account pool status.')}</p>
        ) : !data ? (
          <p role="status">{t('Checking account pool status…')}</p>
        ) : !data.supported ? (
          <p>{t('Account pooling is unavailable on this runtime.')}</p>
        ) : !data.status.enabled ? (
          <p>{t('Round-robin pool is not configured.')}</p>
        ) : data.status.paused ? (
          <p role="alert" className="text-destructive">
            {t('Account pool paused after access denial. Automatic requests are blocked.')}
          </p>
        ) : !data.status.accounts.some((account) => account.enabled) ? (
          <p role="status">{t('No pool accounts are enabled. Requests are blocked.')}</p>
        ) : data.status.accounts.every(
            (account) => !account.enabled || account.authInvalid || account.failure === 'authentication',
          ) ? (
          <p role="alert" className="text-destructive">
            {t('All enabled pool accounts require sign-in. Requests are blocked.')}
          </p>
        ) : (
          <p>{t('Round robin is enabled. The pool selects an eligible account for each request.')}</p>
        )}
      </div>
      <Button size="sm" variant="ghost" disabled={loading} onClick={refresh}>
        {t('Refresh pool status')}
      </Button>
    </div>
  )
}
