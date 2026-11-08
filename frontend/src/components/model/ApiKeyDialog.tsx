import { useState, useCallback, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Key } from 'lucide-react'
import { providerCredentialsApi } from '@/api/providers'
import type { Provider } from '@/api/providers'
import { type FormAnswer, type FormValue, type IntegrationKeyMethod } from '@/api/oauth'
import {
  buildAnswer,
  hasMissingAnswers,
  methodIdentifier,
  resolveAnswers,
  setAnswerValue,
  visibleFields,
} from '@/lib/formFields'
import { mapOAuthError } from '@/lib/oauthErrors'
import { ProviderAuthField } from '@/components/settings/ProviderAuthField'
import { useProviderAuthMethods } from '@/hooks/useProviderAuthMethods'
import { t } from '@/i18n/translate'

interface ApiKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: Provider | null
  onSuccess: () => void
  hasAccounts: boolean
}

export function ApiKeyDialog({ open, onOpenChange, provider, onSuccess, hasAccounts }: ApiKeyDialogProps) {
  const [apiKey, setApiKey] = useState('')
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: authMethods } = useProviderAuthMethods({
    enabled: open && !!provider,
  })

  const keyMethod = useMemo(
    () =>
      provider
        ? authMethods?.[provider.integrationID ?? provider.id]?.find(
            (method): method is IntegrationKeyMethod => method.type === 'key',
          )
        : undefined,
    [authMethods, provider],
  )

  const answer = useMemo(
    () => resolveAnswers(keyMethod?.form, keyMethod ? answers[methodIdentifier(keyMethod)] : undefined),
    [keyMethod, answers],
  )

  const fields = useMemo(() => (keyMethod ? visibleFields(keyMethod.form ?? [], answer) : []), [keyMethod, answer])

  const canSubmit = apiKey.trim().length > 0 && (!keyMethod || !hasMissingAnswers(keyMethod.form ?? [], answer))

  const handleAnswerChange = useCallback((methodID: string, key: string, value: FormValue | undefined) => {
    setAnswers((prev) => setAnswerValue(prev, methodID, key, value))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!provider || !canSubmit) return

    setIsSubmitting(true)
    setError(null)

    try {
      const requestAnswer = keyMethod && fields.length > 0 ? buildAnswer(keyMethod.form ?? [], answer) : undefined
      await providerCredentialsApi.set(provider.integrationID ?? provider.id, apiKey.trim(), requestAnswer)
      setApiKey('')
      setAnswers({})
      onSuccess()
    } catch (err) {
      setError(mapOAuthError(err, 'credential'))
    } finally {
      setIsSubmitting(false)
    }
  }, [provider, canSubmit, keyMethod, fields, answer, apiKey, onSuccess])

  const handleClose = useCallback(() => {
    setApiKey('')
    setAnswers({})
    setError(null)
    onOpenChange(false)
  }, [onOpenChange])

  if (!provider) return null

  const environmentNames =
    authMethods?.[provider.integrationID ?? provider.id]?.flatMap((method) =>
      method.type === 'env' ? method.names : [],
    ) ?? []

  return (
    <Dialog open={open} onOpenChange={handleClose} modal={false}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {hasAccounts
              ? t('Add {provider} API key', { provider: provider.name })
              : t('Connect {name}', { name: provider.name })}
          </DialogTitle>
          <DialogDescription>
            {hasAccounts
              ? t(
                  'This key is saved as a new account and becomes the selected account. Existing accounts are kept.',
                )
              : t('Enter your API key to use models from {provider}.', {
                  provider: provider.name,
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">{t('API Key')}</Label>
            <Input
              id="api-key"
              type="password"
              placeholder={t('Enter API key')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  handleSubmit()
                }
              }}
              autoFocus
            />
            {environmentNames.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('Environment variable:')}{' '}
                <code className="bg-muted px-1 py-0.5 rounded">{environmentNames.join(', ')}</code>
              </p>
            )}
          </div>

          {keyMethod && fields.length > 0 && (
            <div className="space-y-3">
              {fields.map((field) => (
                <ProviderAuthField
                  key={field.key}
                  field={field}
                  value={answer[field.key]}
                  disabled={isSubmitting}
                  onChange={(value) => handleAnswerChange(methodIdentifier(keyMethod), field.key, value)}
                />
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {hasAccounts ? t('Adding...') : t('Connecting...')}
              </>
            ) : hasAccounts ? (
              t('Add Key')
            ) : (
              t('Connect')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
