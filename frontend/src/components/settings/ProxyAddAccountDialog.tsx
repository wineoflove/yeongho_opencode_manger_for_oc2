import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { ClaudeProxyLogin, ClaudeProxyProvider } from '@/api/claudeProxy'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useClaudeProxyLogin } from '@/hooks/useClaudeProxy'
import { t } from '@/i18n/translate'
import { copyTextToClipboard } from '@/lib/clipboard'
import { showToast } from '@/lib/toast'
import { PROXY_PROVIDER_NAMES, proxyErrorCode, proxyErrorMessage } from './proxyAccountMessages'

function countdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function StepNumber({ value }: { readonly value: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold tabular-nums text-secondary-foreground"
    >
      {value}
    </span>
  )
}

interface ProxyAddAccountDialogProps {
  readonly provider: ClaudeProxyProvider
  readonly onClose: () => void
}

/**
 * Adds a CLIProxy account in two steps: open the provider's sign-in page, then paste the localhost
 * address the browser lands on. The pasted address lives only in this dialog and is dropped on close.
 */
export function ProxyAddAccountDialog({ provider, onClose }: ProxyAddAccountDialogProps) {
  const providerName = PROXY_PROVIDER_NAMES[provider]
  const inputId = useId()
  const hintId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const { start, complete } = useClaudeProxyLogin()
  const [login, setLogin] = useState<ClaudeProxyLogin | null>(null)
  const [redirectUrl, setRedirectUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const now = useClock(login !== null)
  const remaining = login ? Date.parse(login.expiresAt) - now : 0
  const expired = login !== null && (remaining <= 0 || proxyErrorCode(complete.error) === 'LOGIN_EXPIRED')
  const failure = start.isError ? start.error : complete.isError && !expired ? complete.error : null
  const ready = login !== null && !expired && !complete.isPending

  useEffect(() => {
    if (login) inputRef.current?.focus()
  }, [login])

  const openSignIn = () => {
    start.mutate(provider, {
      onSuccess: (created) => {
        complete.reset()
        setLogin(created)
        setRedirectUrl('')
        setCopied(false)
        window.open(created.url, '_blank', 'noopener,noreferrer')
      },
    })
  }
  const copyLink = async (url: string) => {
    setCopied(await copyTextToClipboard(url))
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!login || !ready || !redirectUrl.trim()) return
    complete.mutate(
      { provider, state: login.state, redirectUrl: redirectUrl.trim() },
      {
        onSuccess: () => {
          showToast.success(t('{provider} account added', { provider: providerName }))
          onClose()
        },
      },
    )
  }
  const close = () => {
    if (!complete.isPending) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto break-keep sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Add {provider} account', { provider: providerName })}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <ol role="list" className="space-y-6">
            <li className="flex gap-3">
              <StepNumber value={1} />
              <div className="min-w-0 flex-1 space-y-3">
                <h3 className="text-sm font-medium leading-6 text-foreground">
                  {t('Sign in to {provider}', { provider: providerName })}
                </h3>
                {login && expired ? (
                  <div className="space-y-3">
                    <p role="alert" className="flex items-center gap-2 text-sm text-foreground">
                      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
                      {t('This sign-in link has expired.')}
                    </p>
                    <Button type="button" className="min-h-11" disabled={start.isPending} onClick={openSignIn}>
                      {start.isPending ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw aria-hidden="true" />
                      )}
                      {t('Create a new link')}
                    </Button>
                  </div>
                ) : login ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline" className="min-h-11">
                        <a href={login.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink aria-hidden="true" />
                          {t('Open sign-in page again')}
                        </a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => void copyLink(login.url)}
                      >
                        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copied ? t('Link copied') : t('Copy link')}
                      </Button>
                    </div>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {t('Expires in {time}', { time: countdown(remaining) })}
                    </p>
                  </div>
                ) : (
                  <Button type="button" className="min-h-11" disabled={start.isPending} onClick={openSignIn}>
                    {start.isPending ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <ExternalLink aria-hidden="true" />
                    )}
                    {t('Open sign-in page')}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('To add a different account, use a private window or another browser profile.')}
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <StepNumber value={2} />
              <div className="min-w-0 flex-1 space-y-3">
                <h3 className="text-sm font-medium leading-6 text-foreground">{t('Paste the address')}</h3>
                <p id={hintId} className="text-xs text-muted-foreground">
                  {t(
                    "After you sign in, the browser moves to a localhost address and shows that the site can't be reached. That is expected. Copy the full URL from the address bar and paste it here.",
                  )}
                </p>
                <div className="space-y-2">
                  <Label htmlFor={inputId}>{t('Address after sign-in')}</Label>
                  <Input
                    ref={inputRef}
                    id={inputId}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-describedby={hintId}
                    value={redirectUrl}
                    disabled={!ready}
                    onChange={(event) => setRedirectUrl(event.target.value)}
                  />
                </div>
              </div>
            </li>
          </ol>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {proxyErrorMessage(failure, 'login')}
            </p>
          )}
          {complete.isPending && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('This can take up to 30 seconds.')}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1 sm:flex-none"
              disabled={complete.isPending}
              onClick={close}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" className="min-h-11 flex-1 sm:flex-none" disabled={!ready || !redirectUrl.trim()}>
              {complete.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {complete.isPending ? t('Registering account…') : t('Register account')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
