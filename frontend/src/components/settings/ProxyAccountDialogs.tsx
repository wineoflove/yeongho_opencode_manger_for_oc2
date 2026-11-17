import { AlertTriangle } from 'lucide-react'
import type { ClaudeProxyAccount } from '@/api/claudeProxy'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { useClaudeProxyAccountRemoval, useClaudeProxyAccountUpdate } from '@/hooks/useClaudeProxy'
import { t } from '@/i18n/translate'
import { proxyErrorMessage } from './proxyAccountMessages'

/** The account a confirmation acts on, with its display name and whether it is the provider's last enabled one. */
export interface ProxyAccountTarget {
  readonly account: ClaudeProxyAccount
  readonly name: string
  readonly last: boolean
}

interface ProxyAccountDialogProps {
  readonly target: ProxyAccountTarget
  readonly providerName: string
  readonly onClose: () => void
}

function FailureMessage({ error }: { readonly error: unknown }) {
  return (
    <p role="alert" className="break-keep text-sm text-destructive">
      {proxyErrorMessage(error, 'account')}
    </p>
  )
}

/** Confirms turning off the last enabled account of a provider, which stops that provider's requests. */
export function ProxyAccountDisableDialog({ target, providerName, onClose }: ProxyAccountDialogProps) {
  const update = useClaudeProxyAccountUpdate()
  const close = () => {
    if (!update.isPending) onClose()
  }
  return (
    <ConfirmDestructiveDialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      onCancel={close}
      onConfirm={() => update.mutate({ id: target.account.id, enabled: false }, { onSuccess: onClose })}
      title={t('Turn off {name}?', { name: target.name })}
      description={t('CLIProxy stops sending requests to this account. You can turn it back on at any time.')}
      warning={t(
        'This is the last enabled {provider} account. While it is off, {provider} requests fail until you add or enable another account.',
        { provider: providerName },
      )}
      confirmLabel={t('Turn off')}
      pendingLabel={t('Turning off…')}
      isPending={update.isPending}
    >
      {update.isError && <FailureMessage error={update.error} />}
    </ConfirmDestructiveDialog>
  )
}

/** Confirms deleting an account from CLIProxy, warning when it is the provider's last enabled account. */
export function ProxyAccountDeleteDialog({ target, providerName, onClose }: ProxyAccountDialogProps) {
  const removal = useClaudeProxyAccountRemoval()
  const close = () => {
    if (!removal.isPending) onClose()
  }
  return (
    <DeleteDialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      onCancel={close}
      onConfirm={() => removal.mutate(target.account.id, { onSuccess: onClose })}
      title={t('Delete {name}', { name: target.name })}
      description={t('This removes the account from CLIProxy. To use it again, you need to sign in again.')}
      isDeleting={removal.isPending}
    >
      {target.last && (
        <Alert className="overflow-hidden">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <AlertDescription className="break-keep">
            {t(
              'This is the last enabled {provider} account. After it is deleted, {provider} requests fail until you add or enable another account.',
              { provider: providerName },
            )}
          </AlertDescription>
        </Alert>
      )}
      {removal.isError && <FailureMessage error={removal.error} />}
    </DeleteDialog>
  )
}
