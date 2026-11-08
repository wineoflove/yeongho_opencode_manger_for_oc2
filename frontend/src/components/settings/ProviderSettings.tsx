import { useState, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { Loader2, Check, X, Shield, ChevronDown, ChevronRight, Key, Search, Pencil, Trash2 } from 'lucide-react'
import { providerCredentialsApi } from '@/api/providers'
import type { Provider } from '@/api/providers'
import { type OAuthAuthorizeResponse } from '@/api/oauth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { OAuthAuthorizeDialog } from './OAuthAuthorizeDialog'
import { OAuthCallbackDialog } from './OAuthCallbackDialog'
import { ApiKeyDialog } from '@/components/model/ApiKeyDialog'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'
import { useProviders } from '@/hooks/useProviders'
import { useProviderAuthMethods } from '@/hooks/useProviderAuthMethods'
import { t, tn } from '@/i18n/translate'
import { ProviderAccounts } from './ProviderAccounts'
import { ProviderRateLimits } from './ProviderRateLimits'

export function ProviderSettings() {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [oauthCallbackDialogOpen, setOauthCallbackDialogOpen] = useState(false)
  const [oauthResponse, setOauthResponse] = useState<OAuthAuthorizeResponse | null>(null)
  const [connectedExpanded, setConnectedExpanded] = useState(false)
  const [availableExpanded, setAvailableExpanded] = useState(true)
  const [availableSearch, setAvailableSearch] = useState('')
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [apiKeyProvider, setApiKeyProvider] = useState<Provider | null>(null)
  const [apiKeyMode, setApiKeyMode] = useState<'add' | 'edit'>('add')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
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
    onSuccess: () => {
      invalidateProviderCaches(queryClient)
    },
  })

  const handleDeleteCredential = (providerId: string) => {
    setDeleteTarget(authenticationId(providerId))
  }

  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      deleteCredentialMutation.mutate(deleteTarget)
      setDeleteTarget(null)
    }
  }

  const handleDeleteCancel = () => {
    setDeleteTarget(null)
  }

  const handleOAuthAuthorize = (response: OAuthAuthorizeResponse) => {
    setOauthResponse(response)
    setOauthDialogOpen(false)
    setOauthCallbackDialogOpen(true)
  }

  const handleOAuthDialogClose = () => {
    setOauthDialogOpen(false)
    setSelectedProvider(null)
  }

  const handleOAuthSuccess = () => {
    invalidateProviderCaches(queryClient)
    setOauthCallbackDialogOpen(false)
    setOauthResponse(null)
    setSelectedProvider(null)
  }

  const supportsOAuth = useCallback(
    (providerId: string) => {
      const methods = authMethods?.[authenticationId(providerId)] || []
      return methods.some((method) => method.type === 'oauth')
    },
    [authMethods, authenticationId],
  )

  const hasCredentials = useCallback(
    (providerId: string) => {
      return credentialsList?.includes(authenticationId(providerId)) || false
    },
    [credentialsList, authenticationId],
  )

  const oauthProviders = useMemo(() => {
    if (!providers || !authMethods) return []
    const oauth = providers.filter((provider) => supportsOAuth(provider.id))
    return oauth.slice().sort((a, b) => {
      const aConnected = hasCredentials(a.id) ? 1 : 0
      const bConnected = hasCredentials(b.id) ? 1 : 0
      return bConnected - aConnected
    })
  }, [providers, authMethods, supportsOAuth, hasCredentials])

  const apiKeyProviders = useMemo(() => {
    if (!providers || !authMethods) return { connected: [], available: [] }
    const nonOAuthProviders = providers.filter((provider) => !supportsOAuth(provider.id))
    const connected = nonOAuthProviders.filter((provider) => hasCredentials(provider.id))
    const available = nonOAuthProviders.filter((provider) => !hasCredentials(provider.id))
    return { connected, available }
  }, [providers, authMethods, supportsOAuth, hasCredentials])

  const filteredAvailableProviders = useMemo(() => {
    if (!availableSearch.trim()) return apiKeyProviders.available
    const search = availableSearch.toLowerCase()
    return apiKeyProviders.available.filter(
      (provider) => provider.name.toLowerCase().includes(search) || provider.id.toLowerCase().includes(search),
    )
  }, [apiKeyProviders.available, availableSearch])

  const selectedProviderName = useMemo(() => {
    if (!selectedProvider) return ''
    return providers?.find((p) => p.id === selectedProvider)?.name || selectedProvider
  }, [selectedProvider, providers])

  const handleAddApiKey = useCallback((provider: Provider) => {
    setApiKeyProvider(provider)
    setApiKeyMode('add')
    setApiKeyDialogOpen(true)
  }, [])

  const handleEditApiKey = useCallback((provider: Provider) => {
    setApiKeyProvider(provider)
    setApiKeyMode('edit')
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

  return (
    <div className="@container w-full max-w-7xl space-y-8">
      <div className="grid gap-8 @min-[1000px]:grid-cols-2 @min-[1000px]:items-start">
        <div className="min-w-0 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">{t('OAuth Providers')}</h2>
            <p className="text-sm text-muted-foreground">{t('Connect to AI providers using OAuth authentication.')}</p>
          </div>

          {oauthProviders.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground text-center">
                  {t('No OAuth-capable providers available.')}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="divide-y divide-border">
              {oauthProviders.map((provider) => {
                const hasKey = hasCredentials(provider.id)
                const modelCount = provider.models.length

                return (
                  <div key={provider.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{provider.name || provider.id}</p>
                      {modelCount > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {tn('{count} model', '{count} models', modelCount)}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {hasKey ? (
                        <Badge
                          variant="default"
                          className="bg-success text-success-foreground hover:bg-success/90 shrink-0"
                        >
                          <Check className="h-3 w-3 mr-1" />
                          {t('Connected')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="shrink-0">
                          <X className="h-3 w-3 mr-1" />
                          {t('Not Connected')}
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant={hasKey ? 'outline' : 'default'}
                        onClick={() => {
                          setSelectedProvider(provider.id)
                          setOauthDialogOpen(true)
                        }}
                      >
                        <Shield className="h-4 w-4 mr-1" />
                        {hasKey ? t('Reconnect') : t('Connect')}
                      </Button>
                      {hasKey && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDeleteCredential(provider.id)}
                          disabled={deleteCredentialMutation.isPending}
                        >
                          {t('Disconnect')}
                        </Button>
                      )}
                    </div>
                    {hasKey && (
                      <div className="w-full min-w-0">
                        <ProviderAccounts integrationId={authenticationId(provider.id)} />
                      </div>
                    )}
                    <div className="w-full min-w-0">
                      <ProviderRateLimits providerId={provider.id} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {selectedProvider && (
            <OAuthAuthorizeDialog
              providerId={authenticationId(selectedProvider)}
              providerName={selectedProviderName}
              methods={authMethods?.[authenticationId(selectedProvider)] || []}
              open={oauthDialogOpen}
              onOpenChange={handleOAuthDialogClose}
              onSuccess={handleOAuthAuthorize}
            />
          )}

          {selectedProvider && oauthResponse && (
            <OAuthCallbackDialog
              providerId={authenticationId(selectedProvider)}
              providerName={selectedProviderName}
              authResponse={oauthResponse}
              open={oauthCallbackDialogOpen}
              onOpenChange={setOauthCallbackDialogOpen}
              onSuccess={handleOAuthSuccess}
            />
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-2">{t('API Keys')}</h2>
            <p className="text-sm text-muted-foreground">{t('Manage API keys for AI providers.')}</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => setConnectedExpanded(!connectedExpanded)}
              aria-expanded={connectedExpanded}
              className="flex items-center gap-2 w-full text-left py-2 px-1 hover:bg-accent/50 rounded-md transition-colors"
            >
              {connectedExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium text-sm">{t('Connected')}</span>
              <Badge variant="secondary" className="ml-auto">
                {apiKeyProviders.connected.length}
              </Badge>
            </button>

            {connectedExpanded && (
              <div className="pl-6 space-y-2">
                {apiKeyProviders.connected.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    {t('No providers configured. Add an API key below to get started.')}
                  </p>
                ) : (
                  apiKeyProviders.connected.map((provider) => {
                    const modelCount = provider.models.length
                    return (
                      <Card key={provider.id} className="bg-card border-border">
                        <CardHeader className="p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <CardTitle className="text-sm truncate">{provider.name || provider.id}</CardTitle>
                              {modelCount > 0 && (
                                <CardDescription className="text-xs">
                                  {tn('{count} model', '{count} models', modelCount)}
                                </CardDescription>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Badge
                                variant="default"
                                className="bg-success text-success-foreground hover:bg-success/90 shrink-0 text-xs"
                              >
                                <Check className="h-3 w-3 mr-1" />
                                {t('Connected')}
                              </Badge>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleEditApiKey(provider)}
                                aria-label={t('Edit API key for {provider}', {
                                  provider: provider.name || provider.id,
                                })}
                                className="h-8 w-8 p-0"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDeleteCredential(provider.id)}
                                disabled={deleteCredentialMutation.isPending}
                                aria-label={t('Remove credentials for {provider}', {
                                  provider: provider.name || provider.id,
                                })}
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="px-3 pb-3 pt-0">
                          <ProviderAccounts integrationId={authenticationId(provider.id)} />
                          <ProviderRateLimits providerId={provider.id} />
                        </CardContent>
                      </Card>
                    )
                  })
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <button
              onClick={() => setAvailableExpanded(!availableExpanded)}
              aria-expanded={availableExpanded}
              className="flex items-center gap-2 w-full text-left py-2 px-1 hover:bg-accent/50 rounded-md transition-colors"
            >
              {availableExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium text-sm">{t('Available Providers')}</span>
              <Badge variant="secondary" className="ml-auto">
                {apiKeyProviders.available.length}
              </Badge>
            </button>

            {availableExpanded && (
              <div className="pl-6 space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('Search providers...')}
                    value={availableSearch}
                    onChange={(e) => setAvailableSearch(e.target.value)}
                    className="pl-9 md:text-sm"
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-2 max-h-96 overflow-y-auto pt-4 pb-1 pr-1 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black)]">
                  {filteredAvailableProviders.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      {availableSearch ? t('No providers match your search.') : t('No available providers.')}
                    </p>
                  ) : (
                    filteredAvailableProviders.map((provider, index) => {
                      const modelCount = provider.models.length
                      return (
                        <div
                          key={provider.id}
                          className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded-md hover:bg-accent/80 transition-colors ${index % 2 === 1 ? 'bg-accent/30' : ''}`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm truncate block">{provider.name || provider.id}</span>
                            {modelCount > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {tn('{count} model', '{count} models', modelCount)}
                              </span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleAddApiKey(provider)}
                            className="h-7 px-2"
                          >
                            <Key className="h-3.5 w-3.5 mr-1" />
                            {t('Add Key')}
                          </Button>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {apiKeyProvider && (
        <ApiKeyDialog
          open={apiKeyDialogOpen}
          onOpenChange={handleApiKeyDialogClose}
          provider={apiKeyProvider}
          onSuccess={handleApiKeySuccess}
          mode={apiKeyMode}
        />
      )}

      <DeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title={t('Remove Credentials')}
        description={t('Are you sure you want to remove credentials for {provider}?', {
          provider: deleteTarget || t('this provider'),
        })}
        isDeleting={deleteCredentialMutation.isPending}
      />
    </div>
  )
}
