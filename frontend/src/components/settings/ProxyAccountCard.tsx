import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import type { ClaudeProxyAccount, ClaudeProxyProvider } from '@/api/claudeProxy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useClaudeProxyAccountUpdate } from '@/hooks/useClaudeProxy'
import { t } from '@/i18n/translate'
import { ProxyAccountDeleteDialog, ProxyAccountDisableDialog, type ProxyAccountTarget } from './ProxyAccountDialogs'
import { ProxyAccountRow } from './ProxyAccountRow'
import { PROXY_PROVIDER_NAMES, proxyErrorMessage } from './proxyAccountMessages'

interface ProxyAccountCardProps {
  readonly provider: ClaudeProxyProvider
  readonly accounts: readonly ClaudeProxyAccount[]
  readonly onAdd: () => void
}

/**
 * The CLIProxy accounts of one provider. Turning off or deleting the provider's last enabled account
 * goes through a confirmation that says its requests will fail.
 */
export function ProxyAccountCard({ provider, accounts, onAdd }: ProxyAccountCardProps) {
  const titleId = useId()
  const providerName = PROXY_PROVIDER_NAMES[provider]
  const update = useClaudeProxyAccountUpdate()
  const [disabling, setDisabling] = useState<ProxyAccountTarget | null>(null)
  const [deleting, setDeleting] = useState<ProxyAccountTarget | null>(null)
  const enabledCount = accounts.filter((account) => account.enabled).length
  const availableCount = accounts.filter((account) => account.enabled && account.available).length
  const target = (account: ClaudeProxyAccount, name: string): ProxyAccountTarget => ({
    account,
    name,
    last: account.enabled && enabledCount === 1,
  })
  const toggle = (next: ProxyAccountTarget, enabled: boolean) => {
    if (!enabled && next.last) {
      update.reset()
      setDisabling(next)
      return
    }
    update.mutate({ id: next.account.id, enabled })
  }

  return (
    <Card role="region" aria-labelledby={titleId} className="flex min-w-0 flex-col">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-4 pb-1">
        <CardTitle id={titleId} className="text-base">
          {providerName}
        </CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {t('{available}/{total} available', {
            available: availableCount,
            total: accounts.length,
          })}
        </Badge>
      </CardHeader>
      <CardContent className="flex-1 px-4 pb-1">
        {accounts.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-3">
            <p className="text-sm text-muted-foreground">
              {t('No {provider} accounts are registered yet.', {
                provider: providerName,
              })}
            </p>
            <Button className="min-h-11" onClick={onAdd}>
              <Plus aria-hidden="true" />
              {t('Add account')}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((account, index) => {
              const name = account.label || t('Account {number}', { number: index + 1 })
              return (
                <ProxyAccountRow
                  key={account.id}
                  account={account}
                  name={name}
                  checked={
                    update.isPending && update.variables.id === account.id ? update.variables.enabled : account.enabled
                  }
                  busy={update.isPending}
                  onCheckedChange={(enabled) => toggle(target(account, name), enabled)}
                  onDelete={() => setDeleting(target(account, name))}
                />
              )
            })}
          </ul>
        )}
        {update.isError && (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {proxyErrorMessage(update.error, 'account')}
          </p>
        )}
      </CardContent>
      {accounts.length > 0 && (
        <CardFooter className="p-4 pt-2">
          <Button variant="outline" className="min-h-11" onClick={onAdd}>
            <Plus aria-hidden="true" />
            {t('Add account')}
          </Button>
        </CardFooter>
      )}
      {disabling && (
        <ProxyAccountDisableDialog target={disabling} providerName={providerName} onClose={() => setDisabling(null)} />
      )}
      {deleting && (
        <ProxyAccountDeleteDialog target={deleting} providerName={providerName} onClose={() => setDeleting(null)} />
      )}
    </Card>
  )
}
