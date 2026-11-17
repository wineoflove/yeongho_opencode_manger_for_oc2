import { useState, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, X, Shield, Key } from 'lucide-react'
import type { Provider } from '@/api/providers'
import type { OAuthAuthorizeResponse } from '@/api/oauth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { t, tn } from '@/i18n/translate'
import { invalidateProviderCaches } from '@/lib/queryInvalidation'
import { ClaudeAgentConnection } from './ClaudeAgentConnection'
import type { DirectProviderCatalog } from './DirectProviderSettings'
import { OAuthAuthorizeDialog } from './OAuthAuthorizeDialog'
import { OAuthCallbackDialog } from './OAuthCallbackDialog'
import { ProviderAccounts } from './ProviderAccounts'
import { ProviderRateLimits } from './ProviderRateLimits'

interface DirectOAuthProvidersProps {
  readonly providers: readonly Provider[]
  readonly catalog: DirectProviderCatalog
  readonly removing: boolean
  readonly onAddApiKey: (provider: Provider) => void
  readonly onRemoveAll: (provider: Provider) => void
}

/** OAuth-capable providers with their saved accounts, the OAuth sign-in dialogs and the Claude Agent connection. */
export function DirectOAuthProviders({
  providers,
  catalog,
  removing,
  onAddApiKey,
  onRemoveAll,
}: DirectOAuthProvidersProps) {
  const { authenticationId, hasCredentials, supportsMethod, methods } = catalog
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [oauthCallbackDialogOpen, setOauthCallbackDialogOpen] = useState(false)
  const [oauthResponse, setOauthResponse] = useState<OAuthAuthorizeResponse | null>(null)
  const queryClient = useQueryClient()
  const selectedListed = providers.some((provider) => provider.id === selectedProvider)

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

  const selectedProviderName = useMemo(() => {
    if (!selectedProvider) return ''
    return providers.find((p) => p.id === selectedProvider)?.name || selectedProvider
  }, [selectedProvider, providers])

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-2">{t('OAuth Providers')}</h2>
        <p className="text-sm text-muted-foreground">{t('Connect to AI providers using OAuth authentication.')}</p>
      </div>

      {providers.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">{t('No OAuth-capable providers available.')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-border">
          {providers.map((provider) => {
            const hasKey = hasCredentials(provider.id)
            const modelCount = provider.models.length

            return (
              <div key={provider.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{provider.name || provider.id}</p>
                  {modelCount > 0 && (
                    <p className="text-xs text-muted-foreground">{tn('{count} model', '{count} models', modelCount)}</p>
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
                    {hasKey ? t('Add account') : t('Connect')}
                  </Button>
                  {supportsMethod(provider.id, 'key') && (
                    <Button size="sm" variant="outline" onClick={() => onAddApiKey(provider)}>
                      <Key className="h-4 w-4 mr-1" />
                      {t('Add API key')}
                    </Button>
                  )}
                  {hasKey && (
                    <Button size="sm" variant="destructive" onClick={() => onRemoveAll(provider)} disabled={removing}>
                      {t('Remove all accounts')}
                    </Button>
                  )}
                </div>
                {hasKey && (
                  <div className="w-full min-w-0">
                    <ProviderAccounts integrationId={authenticationId(provider.id)} providerId={provider.id} />
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

      <div className="pt-4">
        <ClaudeAgentConnection />
      </div>

      {selectedProvider && (
        <OAuthAuthorizeDialog
          providerId={authenticationId(selectedProvider)}
          providerName={selectedProviderName}
          methods={methods(selectedProvider)}
          hasAccounts={hasCredentials(selectedProvider)}
          open={oauthDialogOpen && selectedListed}
          onOpenChange={handleOAuthDialogClose}
          onSuccess={handleOAuthAuthorize}
        />
      )}

      {selectedProvider && oauthResponse && (
        <OAuthCallbackDialog
          providerId={authenticationId(selectedProvider)}
          providerName={selectedProviderName}
          authResponse={oauthResponse}
          open={oauthCallbackDialogOpen && selectedListed}
          onOpenChange={setOauthCallbackDialogOpen}
          onSuccess={handleOAuthSuccess}
        />
      )}
    </div>
  )
}
