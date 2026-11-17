import { Badge } from '@/components/ui/badge'
import { useId, useState } from 'react'
import type { ProviderAccount, ProviderPoolResponse } from '@opencode-manager/shared/schemas'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { Button } from '@/components/ui/button'
import { useProviderAccounts } from '@/hooks/useProviderAccounts'
import { FetchError } from '@opencode-manager/shared'
import { t } from '@/i18n/translate'
import { ProviderAccountRenameDialog } from './ProviderAccountRenameDialog'
import { ProviderPoolStatus } from './ProviderPoolStatus'
import { useProviderPool } from '@/hooks/useProviderPool'
import { formatDateTime } from '@/i18n/format'
import { ProviderPoolDialog } from './ProviderPoolDialog'

export function ProviderAccounts({
  integrationId,
  providerId = integrationId,
}: {
  readonly integrationId: string
  readonly providerId?: string
}) {
  const { query, mutation } = useProviderAccounts(integrationId)
  const pool = useProviderPool(providerId)
  const poolState = pool.data?.supported ? pool.data.status : undefined
  const pooled = poolState?.enabled === true
  const manual = !pool.isPending && !pool.isError && !pooled
  const [editingPool, setEditingPool] = useState<Extract<ProviderPoolResponse, { supported: true }> | null>(null)
  const [poolSaved, setPoolSaved] = useState<'saved' | 'pending' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProviderAccount | null>(null)
  const [renameTarget, setRenameTarget] = useState<ProviderAccount | null>(null)
  const selectionScopeId = useId()
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
      <ProviderPoolStatus
        data={pool.data}
        failed={pool.isError}
        loading={pool.isFetching}
        refresh={() => {
          void pool.refetch()
        }}
      />
      {pool.data?.supported && pool.data.configRevision && (
        <Button
          size="sm"
          variant="outline"
          disabled={pool.isFetching || pool.isError}
          onClick={() => {
            const current = pool.data
            if (current?.supported) {
              setPoolSaved(null)
              setEditingPool(current)
            }
          }}
        >
          {t('Configure account pool')}
        </Button>
      )}
      {poolSaved && (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          {t(
            poolSaved === 'pending'
              ? 'Pool configuration saved. These changes are pending runtime application.'
              : 'Pool configuration saved. Refresh the status to verify the effective configuration.',
          )}
        </p>
      )}
      {editingPool?.configRevision && (
        <ProviderPoolDialog
          providerId={providerId}
          accounts={query.data?.accounts ?? []}
          status={editingPool.status}
          revision={editingPool.configRevision}
          onClose={() => setEditingPool(null)}
          onSaved={(pending) => {
            setEditingPool(null)
            setPoolSaved(pending ? 'pending' : 'saved')
          }}
        />
      )}
      {query.isError && (
        <p role="alert" className="py-2 text-sm text-destructive">
          {t('Could not load provider accounts.')}
        </p>
      )}
      {mutation.isError && mutation.variables?.kind === 'activate' && (
        <p role="alert" className="py-2 text-sm text-destructive">
          {t('Account change could not be confirmed. Review the current selection and try again.')}
        </p>
      )}
      {!query.data?.accounts.length && (
        <p className="py-2 text-sm text-muted-foreground">{t('No saved accounts for this provider.')}</p>
      )}
      <ul aria-label={t('Saved provider accounts')} className="w-full min-w-0 divide-y divide-border">
        {query.data?.accounts.map((account) => {
          const poolAccount = poolState?.accounts.find((entry) => entry.credentialID === account.id)
          return (
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
                {pooled && (
                  <p className="break-words text-xs text-muted-foreground">
                    {!poolAccount
                      ? t('Not included in this pool')
                      : !poolAccount.enabled
                        ? t('Pool account disabled')
                        : poolAccount.authInvalid
                          ? t('Account sign-in required')
                          : poolAccount.cooldownUntil !== null && poolAccount.cooldownUntil > Date.now()
                            ? t('Waiting until {time}', {
                                time: formatDateTime(poolAccount.cooldownUntil),
                              })
                            : t(poolState.paused ? 'Account pool is paused' : 'Eligible for round robin')}
                  </p>
                )}
              </div>
              <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                {manual &&
                  (account.active ? (
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
                      aria-describedby={selectionScopeId}
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
                  ))}
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
          )
        })}
      </ul>
      {manual && query.data?.accounts.some((account) => !account.active) && (
        <p id={selectionScopeId} className="py-2 text-xs text-muted-foreground">
          {t(
            'The selected account applies to every session on this OpenCode server, starting with its next request. It is not kept per session.',
          )}
        </p>
      )}
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
            {mutation.error instanceof FetchError && mutation.error.code === 'POOL_ACCOUNT_IN_USE'
              ? t('Remove this account from the pool configuration before deleting it.')
              : mutation.error instanceof FetchError && mutation.error.code === 'POOL_CONFIG_UNAVAILABLE'
                ? t('The pool configuration could not be checked. The account was not deleted.')
                : t('Account deletion could not be confirmed. Review the account list before trying again.')}
          </p>
        )}
      </DeleteDialog>
    </div>
  )
}
