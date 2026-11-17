import { useId, useState } from 'react'
import { AlertTriangle, ChevronDown, Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useClaudeProxy, type ClaudeProxyState } from '@/hooks/useClaudeProxy'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import { DirectProviderSettings } from './DirectProviderSettings'
import { ProxyAccountsSection } from './ProxyAccountsSection'

type ProviderView = 'loading' | 'native' | 'proxy' | 'unavailable'

const layoutClassName = '@container w-full max-w-7xl space-y-8'

/**
 * Layout for the current CLIProxy ownership. A background re-check keeps the last confirmed layout;
 * only the first check, before any answer, shows the loading state.
 */
function providerView({ ownership, status }: ClaudeProxyState): ProviderView {
  if (ownership !== 'checking') return ownership
  if (!status.data) return 'loading'
  return status.data.ownsInference ? 'proxy' : 'native'
}

function DirectLoginDisclosure() {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return (
    <section className="space-y-4 break-keep border-t border-border pt-6">
      <h2 className="text-lg font-semibold text-foreground">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('Direct login (advanced)')}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-5 w-5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
      </h2>
      <div id={contentId} hidden={!open} className="space-y-6">
        {open && (
          <>
            <Alert role="note" className="border-warning/40 bg-warning/10 [&>svg]:text-warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="break-keep">
                {t(
                  "Accounts signed in here do not go through CLIProxy. Manage Claude and OpenAI accounts in 'AI accounts' above.",
                )}
              </AlertDescription>
            </Alert>
            <DirectProviderSettings proxyManaged />
          </>
        )}
      </div>
    </section>
  )
}

export function ProviderSettings() {
  const proxy = useClaudeProxy()
  const view = providerView(proxy)

  if (view === 'loading') {
    return (
      <div role="status" className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t('Loading…')}</span>
      </div>
    )
  }

  if (view === 'native') {
    return (
      <div className={layoutClassName}>
        <DirectProviderSettings proxyManaged={false} />
      </div>
    )
  }

  return (
    <div className={layoutClassName}>
      <ProxyAccountsSection proxy={proxy} />
      <DirectLoginDisclosure />
    </div>
  )
}
