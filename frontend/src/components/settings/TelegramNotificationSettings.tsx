import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { TelegramSettingsResponse } from '@opencode-manager/shared/schemas'
import { notificationsApi } from '@/api/notifications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n/translate'

/** Edits the server-wide Telegram destination and sends a test message through the saved settings. */
export function TelegramNotificationSettings() {
  const id = useId()
  const [saved, setSaved] = useState<TelegramSettingsResponse>()
  const [enabled, setEnabled] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<'save' | 'test' | null>(null)
  const busy = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const hostname = window.location.hostname.toLowerCase()
  const suggestedOrigin =
    window.location.protocol === 'https:' &&
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(hostname) &&
    !/\.(localhost|local|internal|lan)$/.test(hostname)
      ? window.location.origin
      : ''

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setLoadError(false)
      try {
        const data = await notificationsApi.getTelegramSettings()
        if (!active) return
        setSaved(data)
        setEnabled(data.enabled)
        setChatId(data.chatId)
        setPublicUrl(data.publicUrl)
      } catch {
        if (active) setLoadError(true)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [attempt])

  const dirty =
    !!saved &&
    (enabled !== saved.enabled || chatId !== saved.chatId || publicUrl !== saved.publicUrl || botToken !== '')

  function clearOutcome() {
    setNotice('')
    setError('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy.current || !saved) return
    clearOutcome()
    if (enabled && ((!botToken.trim() && !saved.hasBotToken) || !chatId.trim() || !publicUrl.trim())) {
      setError(t('Enter a bot token, chat ID and external HTTPS URL before enabling Telegram.'))
      return
    }
    busy.current = true
    setPending('save')
    try {
      const data = await notificationsApi.updateTelegramSettings({
        enabled,
        chatId: chatId.trim(),
        publicUrl: publicUrl.trim(),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      })
      setSaved(data)
      setEnabled(data.enabled)
      setChatId(data.chatId)
      setPublicUrl(data.publicUrl)
      setBotToken('')
      setNotice(t('Telegram settings saved. Changes apply immediately.'))
    } catch {
      setError(t('Could not save Telegram settings. Check the token, chat ID and public HTTPS origin, then retry.'))
    } finally {
      busy.current = false
      setPending(null)
    }
  }

  async function test() {
    if (busy.current || dirty || !saved?.enabled) return
    busy.current = true
    setPending('test')
    clearOutcome()
    try {
      const result = await notificationsApi.testTelegram()
      if (result.ok && result.status === 'sent') {
        setNotice(t('Telegram accepted the test message. Check that it arrived in the intended chat.'))
      } else if (result.status === 'not_configured') {
        setError(t('Telegram is not configured or enabled on the server. Save an enabled configuration first.'))
      } else {
        setError(t('Telegram test failed. Check the bot token, destination and server connection, then retry.'))
      }
    } catch {
      setError(t('Telegram test failed. Check the bot token, destination and server connection, then retry.'))
    } finally {
      busy.current = false
      setPending(null)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 break-keep rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
          {t('Telegram Notifications')}
        </h2>
        {saved && (
          <span className="text-sm text-muted-foreground">
            {saved.source === 'none' ? t('Not configured') : saved.enabled ? t('Enabled') : t('Disabled')}
          </span>
        )}
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading Telegram settings...')}
        </p>
      ) : loadError ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {t('Could not load Telegram settings.')}
          </p>
          <Button variant="outline" className="min-h-11" onClick={() => setAttempt(attempt + 1)}>
            {t('Retry')}
          </Button>
        </div>
      ) : (
        saved && (
          <form onSubmit={save} onChange={clearOutcome} className="space-y-5">
            <fieldset disabled={pending !== null} className="min-w-0 space-y-5">
              <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-enabled`} className="text-base leading-snug">
                    {t('Enable Telegram notifications')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('One shared destination for this server, independent of browser push.')}
                  </p>
                </div>
                <Switch
                  id={`${id}-enabled`}
                  checked={enabled}
                  onCheckedChange={(value) => {
                    setEnabled(value)
                    clearOutcome()
                  }}
                />
              </div>
              {saved.source === 'env' && (
                <p className="text-sm text-muted-foreground">
                  {t('Using environment defaults. Saving here overrides them, including when disabled.')}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor={`${id}-token`}>{t('Bot token')}</Label>
                <Input
                  id={`${id}-token`}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  className="min-h-11"
                  aria-describedby={`${id}-token-help`}
                />
                <p id={`${id}-token-help`} className="text-sm text-muted-foreground">
                  {saved.hasBotToken
                    ? t('Token saved. Leave blank to keep it; enter a new token to replace it.')
                    : t('Enter the token from @BotFather here, never in an agent chat.')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-chat`}>{t('Chat ID')}</Label>
                <Input
                  id={`${id}-chat`}
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-url`}>{t('External OCM HTTPS URL')}</Label>
                <Input
                  id={`${id}-url`}
                  type="url"
                  value={publicUrl}
                  onChange={(event) => setPublicUrl(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11"
                  aria-describedby={`${id}-url-help`}
                />
                {suggestedOrigin && !publicUrl && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 max-w-full whitespace-normal break-all"
                    onClick={() => {
                      setPublicUrl(suggestedOrigin)
                      clearOutcome()
                    }}
                  >
                    {t('Use current address: {url}', { url: suggestedOrigin })}
                  </Button>
                )}
                <p id={`${id}-url-help`} className="text-sm text-muted-foreground">
                  {t('Use an already reachable public HTTPS origin without a path. OCM sign-in is still required; this does not create a tunnel.')}
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button type="submit" className="min-h-11" disabled={!dirty && saved.source === 'db'}>
                  {pending === 'save' ? t('Saving...') : t('Save')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={dirty || !saved.enabled}
                  onClick={test}
                >
                  {pending === 'test' ? t('Testing...') : t('Send Telegram test')}
                </Button>
              </div>
            </fieldset>
            <p className="text-sm text-muted-foreground">
              {dirty
                ? t('Save changes before sending a Telegram test.')
                : !saved.enabled
                  ? t('Enable and save Telegram settings before testing.')
                  : t('The Telegram test uses saved settings only, not browser push.')}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-foreground">
                {notice}
              </p>
            )}
            <div className="space-y-3 border-t border-border pt-4 text-sm text-muted-foreground">
              <h3 className="font-medium text-foreground">{t('Telegram setup')}</h3>
              <ol className="list-decimal space-y-2 pl-5">
                <li>{t('Create a dedicated bot with @BotFather.')}</li>
                <li>{t('Open your bot in Telegram and send /start.')}</li>
                <li>{t('Find your own chat ID with getUpdates and verify the destination before saving.')}</li>
              </ol>
              <a
                href="https://core.telegram.org/bots/tutorial"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('Official Telegram bot guide')}
              </a>
              <p>
                {t('The token is encrypted on the server and never shown again. Notification content leaves OCM and is sent to Telegram; use a private chat you control.')}
              </p>
            </div>
          </form>
        )
      )}
    </section>
  )
}
