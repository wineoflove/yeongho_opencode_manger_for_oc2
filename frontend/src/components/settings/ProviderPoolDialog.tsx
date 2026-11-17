import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProviderAccount, ProviderPoolResponse } from '@opencode-manager/shared/schemas'
import { configureProviderPool } from '@/api/providerPool'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n/translate'

export function ProviderPoolDialog({
  providerId,
  accounts,
  status,
  revision,
  onClose,
  onSaved,
}: {
  readonly providerId: string
  readonly accounts: readonly ProviderAccount[]
  readonly status: Extract<ProviderPoolResponse, { supported: true }>['status']
  readonly revision: string
  readonly onClose: () => void
  readonly onSaved: (pending: boolean) => void
}) {
  const client = useQueryClient()
  const [members, setMembers] = useState(() =>
    accounts
      .filter((account) => account.type !== 'external')
      .map((account) => {
        const member = status.accounts.find((entry) => entry.credentialID === account.id)
        return {
          account,
          included: member !== undefined,
          enabled: member?.enabled ?? true,
        }
      }),
  )
  const save = useMutation({
    mutationFn: () =>
      configureProviderPool(providerId, {
        expectedRevision: revision,
        accounts: members
          .filter((member) => member.included)
          .map((member) => ({
            credentialID: member.account.id,
            enabled: member.enabled,
          })),
      }),
    onSuccess: (result) => onSaved(result.applyStatus === 'restart_pending'),
    onSettled: () => client.invalidateQueries({ queryKey: ['provider-pool', providerId] }),
  })
  const included = members.filter((member) => member.included)
  const methods = new Set(included.map((member) => `${member.account.type}:${member.account.methodID ?? ''}`))
  const valid = included.length <= 20 && methods.size <= 1
  const close = () => {
    if (!save.isPending) onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Configure account pool')}</DialogTitle>
          <DialogDescription className="break-keep">
            {t(
              'Select accounts with the same authentication method. Eligible accounts rotate in list order. An empty pool blocks requests instead of using another account.',
            )}
          </DialogDescription>
        </DialogHeader>
        {status.paused && (
          <p role="alert" className="text-sm text-destructive">
            {t('Saving this configuration does not resume a paused pool.')}
          </p>
        )}
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
          {members.map((member) => (
            <li key={member.account.id} className="flex flex-wrap items-center gap-3 py-3">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={member.included}
                  disabled={save.isPending}
                  onChange={(event) =>
                    setMembers((current) =>
                      current.map((entry) =>
                        entry.account.id === member.account.id ? { ...entry, included: event.target.checked } : entry,
                      ),
                    )
                  }
                />
                <span className="break-all">{member.account.label || member.account.id}</span>
              </label>
              <label className="flex shrink-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={t('Enable pool account {name}', {
                    name: member.account.label || member.account.id,
                  })}
                  checked={member.enabled}
                  disabled={!member.included || save.isPending}
                  onChange={(event) =>
                    setMembers((current) =>
                      current.map((entry) =>
                        entry.account.id === member.account.id ? { ...entry, enabled: event.target.checked } : entry,
                      ),
                    )
                  }
                />
                {t('Enabled')}
              </label>
            </li>
          ))}
        </ul>
        {methods.size > 1 && (
          <p role="alert" className="text-sm text-destructive">
            {t('Pool accounts must use the same authentication method.')}
          </p>
        )}
        {save.isError && (
          <p role="alert" className="break-keep text-sm text-destructive">
            {t('Pool configuration was not confirmed. Close this dialog, refresh the status, and try again.')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={save.isPending} onClick={close}>
            {t('Cancel')}
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('Saving...') : t('Save pool configuration')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
