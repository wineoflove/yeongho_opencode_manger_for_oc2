import { useId, useState, type FormEvent } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { SettingsList, SettingsListRow } from '@/components/ui/settings-list'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { useDeleteSecret, useSecretEntries, useSetSecret } from '@/hooks/useSecrets'
import { copyTextToClipboard } from '@/lib/clipboard'
import { showToast } from '@/lib/toast'
import { formatShortRelativeTime } from '@/lib/utils'
import {
  EnvironmentNameSchema,
  SecretNameSchema,
  SecretValueSchema,
  type SecretEntry,
  type SecretKind,
} from '@opencode-manager/shared/schemas'
import type { SecretScope } from '@/api/secrets'
import { msg, t, template } from '@/i18n/translate'

interface KindMeta {
  readonly namespace: string
  readonly nameLabel: string
  readonly valueLabel: string
  readonly add: string
  readonly empty: string
  readonly emptyHint: string
  readonly saved: string
  readonly updated: string
  readonly saveFailed: string
  readonly removed: string
  readonly removeFailed: string
  readonly removeTitle: string
  readonly removeDescription: string
}

const KIND_META: Record<SecretKind, KindMeta> = {
  secret: {
    namespace: 'secrets',
    nameLabel: msg('Secret name'),
    valueLabel: msg('Secret value'),
    add: msg('Add secret'),
    empty: msg('No secrets yet'),
    emptyHint: msg('Secret values are encrypted and never shown again once saved.'),
    saved: msg('Secret saved'),
    updated: msg('Secret updated'),
    saveFailed: msg('Failed to save secret'),
    removed: msg('Secret removed'),
    removeFailed: msg('Failed to remove secret'),
    removeTitle: msg('Remove Secret'),
    removeDescription: msg(
      'This removes the secret from this scope. Sessions that reference it will no longer receive a value.',
    ),
  },
  variable: {
    namespace: 'vars',
    nameLabel: msg('Variable name'),
    valueLabel: msg('Variable value'),
    add: msg('Add variable'),
    empty: msg('No variables yet'),
    emptyHint: msg('Variable values are stored in plain text and shown here.'),
    saved: msg('Variable saved'),
    updated: msg('Variable updated'),
    saveFailed: msg('Failed to save variable'),
    removed: msg('Variable removed'),
    removeFailed: msg('Failed to remove variable'),
    removeTitle: msg('Remove Variable'),
    removeDescription: msg(
      'This removes the variable from this scope. Sessions that reference it will no longer receive a value.',
    ),
  },
}

function secretReference(kind: SecretKind, name: string): string {
  return `\${{ ${KIND_META[kind].namespace}.${name} }}`
}

const PROJECT_CONFIG_EXAMPLE = `{
  "version": 1,
  "environment": "e2e",
  "env": {
    "OPENAI_API_KEY": "\${{ secrets.OPENAI_API_KEY }}",
    "BASE_URL": "\${{ vars.BASE_URL }}"
  }
}`

interface SecretsManagerProps {
  scope: SecretScope
}

export function SecretsManager({ scope }: SecretsManagerProps) {
  const [injectionBefore, injectionAfter] = template(
    'Values are injected into sessions only when the repository maps them in {file}, for example:',
  ).split('{file}')
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {injectionBefore}
        <code className="font-mono">.ocm/project.json</code>
        {injectionAfter}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs">
        {PROJECT_CONFIG_EXAMPLE}
      </pre>
      <p className="text-xs text-muted-foreground">
        {t('Precedence: environment > repository > global. The same reference text works in a GitHub workflow.')}
      </p>

      <Tabs defaultValue="secret">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="secret">{t('Secrets')}</TabsTrigger>
          <TabsTrigger value="variable">{t('Variables')}</TabsTrigger>
        </TabsList>
        <TabsContent value="secret" className="mt-2 px-0">
          <SecretKindPanel scope={scope} kind="secret" />
        </TabsContent>
        <TabsContent value="variable" className="mt-2 px-0">
          <SecretKindPanel scope={scope} kind="variable" />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface SecretFormState {
  name: string
  value: string
  environment: string
}

interface SecretKindPanelProps {
  scope: SecretScope
  kind: SecretKind
}

function SecretKindPanel({ scope, kind }: SecretKindPanelProps) {
  const meta = KIND_META[kind]
  const isRepoScope = scope.scope === 'repo'
  const nameId = useId()
  const environmentId = useId()
  const valueId = useId()

  const entriesQuery = useSecretEntries(scope, kind)
  const setSecret = useSetSecret(scope)
  const deleteSecret = useDeleteSecret(scope)

  const [form, setForm] = useState<SecretFormState | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<SecretEntry | null>(null)

  const entries = entriesQuery.data ?? []

  const startAdd = () => {
    setIsEditing(false)
    setFormError(null)
    setForm({ name: '', value: '', environment: '' })
  }

  const startEdit = (entry: SecretEntry) => {
    setIsEditing(true)
    setFormError(null)
    setForm({ name: entry.name, value: '', environment: entry.environment ?? '' })
  }

  const cancelForm = () => {
    setForm(null)
    setIsEditing(false)
    setFormError(null)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!form) return

    const nameResult = SecretNameSchema.safeParse(form.name)
    if (!nameResult.success) {
      setFormError(nameResult.error.issues[0]?.message ?? t('Invalid name'))
      return
    }

    const valueResult = SecretValueSchema.safeParse(form.value)
    if (!valueResult.success) {
      setFormError(valueResult.error.issues[0]?.message ?? t('Invalid value'))
      return
    }

    let environment: string | undefined
    const trimmedEnvironment = form.environment.trim()
    if (isRepoScope && trimmedEnvironment) {
      const environmentResult = EnvironmentNameSchema.safeParse(trimmedEnvironment)
      if (!environmentResult.success) {
        setFormError(environmentResult.error.issues[0]?.message ?? t('Invalid environment'))
        return
      }
      environment = environmentResult.data
    }

    setFormError(null)
    try {
      await setSecret.mutateAsync({ kind, name: nameResult.data, value: valueResult.data, environment })
      showToast.success(t(isEditing ? meta.updated : meta.saved))
      cancelForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t(meta.saveFailed))
    }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    try {
      await deleteSecret.mutateAsync({
        kind,
        name: removeTarget.name,
        environment: removeTarget.environment ?? undefined,
      })
      showToast.success(t(meta.removed))
      setRemoveTarget(null)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : t(meta.removeFailed))
    }
  }

  const handleCopyReference = async (entry: SecretEntry) => {
    const copied = await copyTextToClipboard(secretReference(kind, entry.name))
    if (copied) showToast.success(t('Reference copied'))
    else showToast.error(t('Failed to copy reference'))
  }

  return (
    <div className="space-y-3">
      {form ? (
        <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor={nameId}>{t(meta.nameLabel)}</Label>
            <Input
              id={nameId}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value.toUpperCase() })}
              placeholder="MY_NAME"
              className="font-mono"
              autoComplete="off"
              disabled={isEditing}
            />
          </div>

          {isRepoScope && (
            <div className="space-y-1">
              <Label htmlFor={environmentId}>{t('Environment (optional)')}</Label>
              <Input
                id={environmentId}
                value={form.environment}
                onChange={(event) => setForm({ ...form, environment: event.target.value })}
                placeholder={t('e.g. {example}', { example: 'e2e' })}
                className="font-mono"
                autoComplete="off"
                disabled={isEditing}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor={valueId}>{t(meta.valueLabel)}</Label>
            <Textarea
              id={valueId}
              value={form.value}
              onChange={(event) => setForm({ ...form, value: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {formError && (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={cancelForm}>
              {t('Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={setSecret.isPending}>
              {setSecret.isPending ? t('Saving...') : t('Save')}
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={startAdd}>
          <Plus className="h-3 w-3 mr-1" />
          {t(meta.add)}
        </Button>
      )}

      <SettingsList
        isLoading={entriesQuery.isLoading}
        error={entriesQuery.error as Error | null}
        isEmpty={entries.length === 0}
        emptyTitle={t(meta.empty)}
        emptyHint={t(meta.emptyHint)}
        maxHeightClassName="max-h-none"
      >
        {entries.map((entry) => (
          <SettingsListRow
            key={`${entry.name}\u0000${entry.environment ?? ''}`}
            className="flex-row items-center gap-2 py-2.5"
            title={<span className="font-mono">{entry.name}</span>}
            badges={entry.environment ? <Badge variant="secondary">{entry.environment}</Badge> : undefined}
            description={
              <span>
                {t('Updated {time}', { time: formatShortRelativeTime(new Date(entry.updatedAt)) })}
                {kind === 'variable' && entry.value !== undefined ? ` · ${entry.value}` : ''}
              </span>
            }
            trailing={
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t('Copy reference for {name}', { name: entry.name })}
                  onClick={() => handleCopyReference(entry)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t('Update {name}', { name: entry.name })}
                  onClick={() => startEdit(entry)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label={t('Remove {name}', { name: entry.name })}
                  onClick={() => setRemoveTarget(entry)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            }
          />
        ))}
      </SettingsList>

      <DeleteDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        onConfirm={handleRemove}
        onCancel={() => setRemoveTarget(null)}
        title={t(meta.removeTitle)}
        description={t(meta.removeDescription)}
        itemName={removeTarget?.name}
        isDeleting={deleteSecret.isPending}
      />
    </div>
  )
}
