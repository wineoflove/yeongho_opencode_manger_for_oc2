import { useId, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import type { ClaudeProxyProvider } from '@/api/claudeProxy'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { ClaudeProxyState } from '@/hooks/useClaudeProxy'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import { ProxyAccountCard } from './ProxyAccountCard'
import { ProxyAddAccountDialog } from './ProxyAddAccountDialog'
import { PROXY_PROVIDERS, PROXY_PROVIDER_NAMES, proxyErrorMessage } from './proxyAccountMessages'

const gridClassName = 'grid gap-4 @min-[720px]:grid-cols-2'

function SectionAlert({ message }: { readonly message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="break-keep">{message}</AlertDescription>
    </Alert>
  )
}

function LoadingCards() {
  return (
    <div className={gridClassName}>
      {PROXY_PROVIDERS.map((provider) => (
        <Card key={provider} className="min-w-0">
          <CardHeader className="p-4 pb-1">
            <CardTitle className="text-base">{PROXY_PROVIDER_NAMES[provider]}</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-24 items-center px-4 pb-4">
            <p role="status" className="text-sm text-muted-foreground">
              {t('Loading accounts…')}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/**
 * The CLIProxy accounts that serve Claude and OpenAI requests in rotation, one card per provider,
 * with the dialog that adds an account.
 */
export function ProxyAccountsSection({ proxy }: { readonly proxy: ClaudeProxyState }) {
  const titleId = useId()
  const [adding, setAdding] = useState<ClaudeProxyProvider | null>(null)
  const { ownership, status, accounts } = proxy
  const loaded = accounts.data
  const refreshing = status.isFetching || accounts.isFetching
  const refresh = () => {
    void status.refetch()
    if (ownership === 'proxy') void accounts.refetch()
  }

  return (
    <section aria-labelledby={titleId} className="space-y-4 break-keep">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose space-y-1">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {t('AI accounts')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'CLIProxy sends Claude and OpenAI requests to the registered accounts in turn (round robin). Turn an account off to leave it out of the rotation.',
            )}
          </p>
        </div>
        <Button variant="outline" className="min-h-11" disabled={refreshing} onClick={refresh}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
          {t('Refresh')}
        </Button>
      </div>
      {ownership === 'unavailable' ? (
        <SectionAlert
          message={t(
            'Could not confirm whether CLIProxy manages the AI accounts. Direct Claude and OpenAI sign-ins stay hidden until it is confirmed.',
          )}
        />
      ) : !loaded ? (
        accounts.isError ? (
          <SectionAlert message={proxyErrorMessage(accounts.error, 'list')} />
        ) : (
          <LoadingCards />
        )
      ) : (
        <>
          {accounts.isError && (
            <SectionAlert message={t('Could not refresh the accounts. Showing the last loaded list.')} />
          )}
          <div className={gridClassName}>
            {PROXY_PROVIDERS.map((provider) => (
              <ProxyAccountCard
                key={provider}
                provider={provider}
                accounts={loaded.accounts.filter((account) => account.provider === provider)}
                onAdd={() => setAdding(provider)}
              />
            ))}
          </div>
        </>
      )}
      {adding && <ProxyAddAccountDialog provider={adding} onClose={() => setAdding(null)} />}
    </section>
  )
}
