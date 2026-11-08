import { useSettings } from '@/hooks/useSettings'
import { useAutosavedSetting } from '@/hooks/useAutosavedSetting'
import { Label } from '@/components/ui/label'
import { ModelCombobox } from '@/components/model/ModelCombobox'
import { t } from '@/i18n/translate'

export function WalkthroughSettings() {
  const { preferences, updateSettings } = useSettings()
  const storedWalkthroughModel = preferences?.walkthroughModel

  const { draft: walkthroughModel, setDraft: setWalkthroughModel } = useAutosavedSetting({
    stored: storedWalkthroughModel,
    toDraft: (stored) => stored ?? '',
    toCommitted: (draft) => draft.trim(),
    isEqual: (a, b) => a === b,
    save: (next) => updateSettings({ walkthroughModel: next }),
  })

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-foreground">{t('Change walkthrough')}</h2>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor="walkthroughModel">{t('Walkthrough model')}</Label>
          <p className="text-sm text-muted-foreground">
            {t("Model of the walkthrough session that builds the walkthrough UI. Leave empty to use the session's model, or the OpenCode default.")}
          </p>
        </div>
        <ModelCombobox
          id="walkthroughModel"
          ariaLabel={t('Walkthrough model')}
          value={walkthroughModel}
          onChange={setWalkthroughModel}
          placeholder={t('Session model')}
          allowCustomValue
          showClear
          emptyMeansDefault={false}
          className="w-full shrink-0 sm:w-64"
        />
      </div>
    </div>
  )
}
