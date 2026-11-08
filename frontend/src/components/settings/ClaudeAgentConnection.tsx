import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ProviderExternalLoginResponse } from '@opencode-manager/shared/schemas'
import { providerExternalApi } from '@/api/providerExternal'
import { providerCredentialsApi } from '@/api/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'
import { msg, t } from '@/i18n/translate'

const integrationID: ProviderExternalLoginResponse['integrationID'] = 'claude-agent'
const statusQueryKey = ['provider-external-login', integrationID] as const

const statusMessages = {
  connected: msg('OpenCode registered the native connection. Inference has not been verified.'),
  needs_auth: msg('OpenCode reports that Claude Code needs a sign-in on the server host.'),
  unconnected: msg('Not connected.'),
  unavailable: msg('This OpenCode server does not offer the Claude Agent connection.'),
} as const satisfies Record<ProviderExternalLoginResponse['status'], string>

export function ClaudeAgentConnection() {
  const titleId = useId()
  const queryClient = useQueryClient()
  const [removalOpen, setRemovalOpen] = useState(false)
  const status = useQuery({ queryKey: statusQueryKey, queryFn: providerExternalApi.getStatus })
  const registration = useMutation({
    mutationFn: providerExternalApi.connect,
    onSuccess: (state) => {
      queryClient.setQueryData(statusQueryKey, state)
      invalidateProviderCaches(queryClient)
    },
  })
  const removal = useMutation({
    mutationFn: () => providerCredentialsApi.delete(integrationID),
    onSettled: () =>
      Promise.all([queryClient.invalidateQueries({ queryKey: statusQueryKey }), invalidateProviderCaches(queryClient)]),
  })
  const state = status.data
  const busy = status.isFetching || registration.isPending || removal.isPending
  const registered = state?.status === 'connected' || state?.status === 'needs_auth'
  const closeRemoval = () => {
    if (!removal.isPending) setRemovalOpen(false)
  }

  return (
    <Card role="region" aria-labelledby={titleId} className="bg-card border-border">
      <CardHeader className="p-3">
        <CardTitle id={titleId} className="text-sm">
          {t('Claude Agent')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t(
            'Uses the official Claude Code login on the OpenCode server host, not on this device. One login per server; separate Claude accounts are not supported.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-3 pt-0">
        {(state || status.isPending) && (
          <p role="status" className="text-sm text-foreground">
            {state ? t(statusMessages[state.status]) : t('Checking status…')}
          </p>
        )}
        {state?.status === 'needs_auth' && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              {t(
                'On the OpenCode server host, run this command as the same system user and with the same environment as the OpenCode server, then refresh the status.',
              )}
            </p>
            <code className="block w-fit max-w-full break-words rounded bg-muted px-2 py-1 font-mono text-foreground">
              {state.instructions.command}
            </code>
            <p className="flex gap-2 text-foreground">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t(
                'Signing in there replaces the Claude Code login already stored for that user and environment, which other tools outside OpenCode may also use.',
              )}
            </p>
          </div>
        )}
        {status.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('Could not load the Claude Agent status.')}
          </p>
        )}
        {registration.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('Could not register the Claude Agent connection. Refresh the status and try again.')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {state?.status === 'unconnected' && (
            <Button size="sm" disabled={busy} onClick={() => registration.mutate()}>
              {t('Use Claude Code login')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              registration.reset()
              void status.refetch()
            }}
          >
            {t('Refresh status')}
          </Button>
          {registered && (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                removal.reset()
                setRemovalOpen(true)
              }}
            >
              {t('Remove connection')}
            </Button>
          )}
        </div>
        <DeleteDialog
          open={removalOpen}
          onOpenChange={(open) => !open && closeRemoval()}
          onCancel={closeRemoval}
          onConfirm={() => removal.mutate(undefined, { onSuccess: () => setRemovalOpen(false) })}
          title={t('Remove Claude Agent connection')}
          description={t(
            'This removes only the connection registered in OpenCode. It does not sign Claude Code out on the server host, and the stored Claude Code login stays as it is.',
          )}
          confirmLabel={t('Remove connection')}
          pendingLabel={t('Removing...')}
          isDeleting={removal.isPending}
        >
          {removal.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                'Could not confirm that the Claude Agent connection was removed. Check the status before trying again.',
              )}
            </p>
          )}
        </DeleteDialog>
      </CardContent>
    </Card>
  )
}
