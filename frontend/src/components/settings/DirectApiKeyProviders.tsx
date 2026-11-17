import { useState, useMemo } from 'react'
import { Check, ChevronDown, ChevronRight, Key, Search, Plus, Trash2 } from 'lucide-react'
import type { Provider } from '@/api/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { t, tn } from '@/i18n/translate'
import { ProviderAccounts } from './ProviderAccounts'
import { ProviderRateLimits } from './ProviderRateLimits'

interface DirectApiKeyProvidersProps {
  readonly connected: readonly Provider[]
  readonly available: readonly Provider[]
  readonly authenticationId: (providerId: string) => string
  readonly removing: boolean
  readonly onAddApiKey: (provider: Provider) => void
  readonly onRemoveAll: (provider: Provider) => void
}

/** API-key providers: the connected ones with their accounts, and a searchable list of the others. */
export function DirectApiKeyProviders({
  connected,
  available,
  authenticationId,
  removing,
  onAddApiKey,
  onRemoveAll,
}: DirectApiKeyProvidersProps) {
  const [connectedExpanded, setConnectedExpanded] = useState(false)
  const [availableExpanded, setAvailableExpanded] = useState(true)
  const [availableSearch, setAvailableSearch] = useState('')

  const filteredAvailableProviders = useMemo(() => {
    if (!availableSearch.trim()) return available
    const search = availableSearch.toLowerCase()
    return available.filter(
      (provider) => provider.name.toLowerCase().includes(search) || provider.id.toLowerCase().includes(search),
    )
  }, [available, availableSearch])

  return (
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
            {connected.length}
          </Badge>
        </button>

        {connectedExpanded && (
          <div className="pl-6 space-y-2">
            {connected.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                {t('No providers configured. Add an API key below to get started.')}
              </p>
            ) : (
              connected.map((provider) => {
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
                            onClick={() => onAddApiKey(provider)}
                            aria-label={t('Add another API key for {provider}', {
                              provider: provider.name || provider.id,
                            })}
                            className="h-8 w-8 p-0"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onRemoveAll(provider)}
                            disabled={removing}
                            aria-label={t('Remove all accounts for {provider}', {
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
                      <ProviderAccounts integrationId={authenticationId(provider.id)} providerId={provider.id} />
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
            {available.length}
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
                      <Button size="sm" variant="ghost" onClick={() => onAddApiKey(provider)} className="h-7 px-2">
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
  )
}
