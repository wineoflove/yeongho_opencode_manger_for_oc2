import { Badge } from '@/components/ui/badge'
import { useState } from 'react'
import type { ProviderAccount } from '@opencode-manager/shared/schemas'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { Button } from '@/components/ui/button'
import { useProviderAccounts } from '@/hooks/useProviderAccounts'
import { t } from '@/i18n/translate'
import { ProviderAccountRenameDialog } from './ProviderAccountRenameDialog'

export function ProviderAccounts({ integrationId }: { readonly integrationId: string }) {
  const { query, mutation } = useProviderAccounts(integrationId)
  const [deleteTarget, setDeleteTarget] = useState<ProviderAccount | null>(null)
  const [renameTarget, setRenameTarget] = useState<ProviderAccount | null>(null)
  if (query.isPending)
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        {t('Loading provider accounts…')}
      </p>
    )
  if (query.isError && !query.data)
    return (
      <div className="flex flex-wrap items-center gap-2 py-2">
        <p role="alert" className="text-sm text-destructive">
          {t('Could not load provider accounts.')}
        </p>
        <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('Retry')}
        </Button>
      </div>
    )
  return (
    <div className="w-full min-w-0">
      {query.isError && (
        <p role="alert" className="py-2 text-sm text-destructive">
          {t('Could not load provider accounts.')}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="py-2 text-sm text-destructive">
          {t('Account change could not be confirmed. Review the current selection and try again.')}
        </p>
      )}
      {!query.data?.accounts.length && (
        <p className="py-2 text-sm text-muted-foreground">{t('No saved accounts for this provider.')}</p>
      )}
      <ul aria-label={t('Saved provider accounts')} className="w-full min-w-0 divide-y divide-border">
        {query.data?.accounts.map((account) => (
          <li key={account.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-32 flex-1">
              <p className="break-words text-sm font-medium text-foreground">{account.label || account.id}</p>
              <p className="text-xs text-muted-foreground">
                {account.type === 'key'
                  ? t('API key')
                  : account.type === 'oauth'
                    ? 'OAuth'
                    : t('External authentication')}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              {account.active ? (
                <Badge variant="secondary" className="shrink-0">
                  {t('Selected account')}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-20"
                  disabled={mutation.isPending || query.isFetching}
                  aria-label={t('Use account {name}', {
                    name: account.label || account.id,
                  })}
                  onClick={() =>
                    mutation.mutate({
                      kind: 'activate',
                      integrationId,
                      accountId: account.id,
                    })
                  }
                >
                  {t('Use account')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="min-w-16"
                disabled={mutation.isPending || query.isFetching}
                aria-label={t('Rename account {name}', {
                  name: account.label || account.id,
                })}
                onClick={() => {
                  mutation.reset()
                  setRenameTarget(account)
                }}
              >
                {t('Rename')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-w-16 text-foreground"
                disabled={mutation.isPending || query.isFetching}
                aria-label={t('Delete account {name}', {
                  name: account.label || account.id,
                })}
                onClick={() => {
                  mutation.reset()
                  setDeleteTarget(account)
                }}
              >
                {t('Delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {renameTarget && (
        <ProviderAccountRenameDialog
          key={renameTarget.id}
          account={renameTarget}
          pending={mutation.isPending}
          failed={mutation.isError}
          onClose={() => setRenameTarget(null)}
          onSave={(label) =>
            mutation.mutate(
              {
                kind: 'rename',
                integrationId,
                accountId: renameTarget.id,
                label,
              },
              { onSuccess: () => setRenameTarget(null) },
            )
          }
        />
      )}
      <DeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setDeleteTarget(null)
        }}
        onCancel={() => {
          if (!mutation.isPending) setDeleteTarget(null)
        }}
        title={t('Delete saved account')}
        description={
          deleteTarget?.active
            ? t(
                'Remove this selected account. OpenCode may automatically select another saved account for this provider.',
              )
            : t('Remove only this saved account. Other accounts will remain connected.')
        }
        itemName={deleteTarget?.label || deleteTarget?.id}
        isDeleting={mutation.isPending}
        onConfirm={() => {
          if (deleteTarget && !mutation.isPending)
            mutation.mutate(
              { kind: 'remove', integrationId, accountId: deleteTarget.id },
              { onSuccess: () => setDeleteTarget(null) },
            )
        }}
      >
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('Account deletion could not be confirmed. Review the account list before trying again.')}
          </p>
        )}
      </DeleteDialog>
    </div>
  )
}
