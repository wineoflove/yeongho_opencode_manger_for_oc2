import { useState, useMemo, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { FetchError } from '@opencode-manager/shared'
import type { ProviderExternalLoginResponse } from '@opencode-manager/shared/schemas'
import { providerCredentialsApi } from '@/api/providers'
import type { Provider } from '@/api/providers'
import type { IntegrationMethod } from '@/api/oauth'
import { ApiKeyDialog } from '@/components/model/ApiKeyDialog'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { useProviders } from '@/hooks/useProviders'
import { useProviderAuthMethods } from '@/hooks/useProviderAuthMethods'
import { t } from '@/i18n/translate'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'
import { DirectApiKeyProviders } from './DirectApiKeyProviders'
import { DirectOAuthProviders } from './DirectOAuthProviders'

const CLAUDE_AGENT_INTEGRATION_ID: ProviderExternalLoginResponse['integrationID'] = 'claude-agent'
const PROXY_MANAGED_INTEGRATIONS: ReadonlySet<string> = new Set(['anthropic', 'openai'])

/** Lookups the direct provider lists share, keyed by model provider ID. */
export interface DirectProviderCatalog {
  readonly authenticationId: (providerId: string) => string
  readonly hasCredentials: (providerId: string) => boolean
  readonly supportsMethod: (providerId: string, type: IntegrationMethod['type']) => boolean
  readonly methods: (providerId: string) => IntegrationMethod[]
}

/**
 * Direct provider sign-ins that bypass CLIProxy: OAuth providers, API keys and the Claude Agent connection.
 *
 * @param proxyManaged Whether CLIProxy may own Claude and OpenAI; their direct sign-ins are then hidden.
 */
export function DirectProviderSettings({ proxyManaged }: { readonly proxyManaged: boolean }) {
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [apiKeyProvider, setApiKeyProvider] = useState<Provider | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)
  const queryClient = useQueryClient()

  const { data: providersData, isLoading: providersLoading } = useProviders()

  const providers = providersData?.providers
  const authenticationId = useCallback(
    (providerId: string) => providers?.find((provider) => provider.id === providerId)?.integrationID ?? providerId,
    [providers],
  )

  const { data: credentialsList, isLoading: credentialsLoading } = useQuery({
    queryKey: ['provider-credentials'],
    queryFn: () => providerCredentialsApi.list(),
  })

  const { data: authMethods } = useProviderAuthMethods()

  const deleteCredentialMutation = useMutation({
    mutationFn: (providerId: string) => providerCredentialsApi.delete(providerId),
    onSettled: () => invalidateProviderCaches(queryClient),
  })

  const handleDeleteCredential = (provider: Provider) => {
    deleteCredentialMutation.reset()
    setDeleteTarget(provider)
  }

  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      deleteCredentialMutation.mutate(authenticationId(deleteTarget.id), {
        onSuccess: () => setDeleteTarget(null),
      })
    }
  }

  const handleDeleteCancel = () => {
    if (!deleteCredentialMutation.isPending) setDeleteTarget(null)
  }

  const directAllowed = useCallback(
    (providerId: string) => !proxyManaged || !PROXY_MANAGED_INTEGRATIONS.has(authenticationId(providerId)),
    [proxyManaged, authenticationId],
  )

  const methods = useCallback(
    (providerId: string) => authMethods?.[authenticationId(providerId)] || [],
    [authMethods, authenticationId],
  )

  const supportsMethod = useCallback(
    (providerId: string, type: IntegrationMethod['type']) => methods(providerId).some((method) => method.type === type),
    [methods],
  )

  const hasCredentials = useCallback(
    (providerId: string) => {
      return credentialsList?.includes(authenticationId(providerId)) || false
    },
    [credentialsList, authenticationId],
  )

  const catalog = useMemo<DirectProviderCatalog>(
    () => ({ authenticationId, hasCredentials, supportsMethod, methods }),
    [authenticationId, hasCredentials, supportsMethod, methods],
  )

  const oauthProviders = useMemo(() => {
    if (!providers || !authMethods) return []
    const oauth = providers.filter((provider) => supportsMethod(provider.id, 'oauth') && directAllowed(provider.id))
    return oauth.slice().sort((a, b) => {
      const aConnected = hasCredentials(a.id) ? 1 : 0
      const bConnected = hasCredentials(b.id) ? 1 : 0
      return bConnected - aConnected
    })
  }, [providers, authMethods, supportsMethod, hasCredentials, directAllowed])

  const apiKeyProviders = useMemo(() => {
    if (!providers || !authMethods) return { connected: [], available: [] }
    const keyProviders = providers.filter(
      (provider) =>
        !supportsMethod(provider.id, 'oauth') &&
        authenticationId(provider.id) !== CLAUDE_AGENT_INTEGRATION_ID &&
        directAllowed(provider.id),
    )
    const connected = keyProviders.filter((provider) => hasCredentials(provider.id))
    const available = keyProviders.filter((provider) => !hasCredentials(provider.id))
    return { connected, available }
  }, [providers, authMethods, supportsMethod, authenticationId, hasCredentials, directAllowed])

  const proxyManagedNames = useMemo(() => {
    if (!providers) return []
    const hidden = providers.filter((provider) => !directAllowed(provider.id))
    return [...new Set(hidden.map((provider) => provider.name || provider.id))]
  }, [providers, directAllowed])

  const handleAddApiKey = useCallback((provider: Provider) => {
    setApiKeyProvider(provider)
    setApiKeyDialogOpen(true)
  }, [])

  const handleApiKeySuccess = useCallback(() => {
    setApiKeyDialogOpen(false)
    setApiKeyProvider(null)
    invalidateProviderCaches(queryClient)
  }, [queryClient])

  const handleApiKeyDialogClose = useCallback((open: boolean) => {
    setApiKeyDialogOpen(open)
    if (!open) {
      setApiKeyProvider(null)
    }
  }, [])

  if (providersLoading || credentialsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const deleteTargetName = deleteTarget ? deleteTarget.name || deleteTarget.id : t('this provider')

  return (
    <>
      {proxyManagedNames.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('Managed in CLIProxy: {providers}', {
            providers: proxyManagedNames.join(', '),
          })}
        </p>
      )}
      <div className="grid gap-8 @min-[1000px]:grid-cols-2 @min-[1000px]:items-start">
        <DirectOAuthProviders
          providers={oauthProviders}
          catalog={catalog}
          removing={deleteCredentialMutation.isPending}
          onAddApiKey={handleAddApiKey}
          onRemoveAll={handleDeleteCredential}
        />
        <DirectApiKeyProviders
          connected={apiKeyProviders.connected}
          available={apiKeyProviders.available}
          authenticationId={authenticationId}
          removing={deleteCredentialMutation.isPending}
          onAddApiKey={handleAddApiKey}
          onRemoveAll={handleDeleteCredential}
        />
      </div>

      {apiKeyProvider && (
        <ApiKeyDialog
          open={apiKeyDialogOpen && directAllowed(apiKeyProvider.id)}
          onOpenChange={handleApiKeyDialogClose}
          provider={apiKeyProvider}
          onSuccess={handleApiKeySuccess}
          hasAccounts={hasCredentials(apiKeyProvider.id)}
        />
      )}

      <DeleteDialog
        open={deleteTarget !== null && directAllowed(deleteTarget.id)}
        onOpenChange={(open) => !open && handleDeleteCancel()}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title={t('Remove all accounts for {provider}', {
          provider: deleteTargetName,
        })}
        description={t(
          'This removes every saved account for {provider}, including the selected account. To remove only one account, use Delete next to that account.',
          { provider: deleteTargetName },
        )}
        confirmLabel={t('Remove all accounts')}
        isDeleting={deleteCredentialMutation.isPending}
      >
        {deleteCredentialMutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {deleteCredentialMutation.error instanceof FetchError &&
            deleteCredentialMutation.error.code === 'POOL_ACCOUNT_IN_USE'
              ? t('Remove the referenced accounts from the pool configuration first. No accounts were deleted.')
              : deleteCredentialMutation.error instanceof FetchError &&
                  deleteCredentialMutation.error.code === 'POOL_CONFIG_UNAVAILABLE'
                ? t('The pool configuration could not be checked. No accounts were deleted.')
                : t(
                    'Could not confirm that every account was removed. Some accounts may remain. Review the account list before trying again.',
                  )}
          </p>
        )}
      </DeleteDialog>
    </>
  )
}
