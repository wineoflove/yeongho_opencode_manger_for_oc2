import { useState } from 'react'
import { SettingsDisclosure } from '@/components/settings/SettingsDisclosure'
import { SecretsManager } from './SecretsManager'
import { t } from '@/i18n/translate'

export function GlobalSecretsSettings() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <SettingsDisclosure
      title={t('Secrets and variables')}
      isOpen={isOpen}
      onToggle={() => setIsOpen((value) => !value)}
      contentClassName="space-y-3"
    >
      <SecretsManager scope={{ scope: 'global' }} />
    </SettingsDisclosure>
  )
}
