import { useEffect, useRef } from 'react'
import { showToast } from '@/lib/toast'
import { useVersionCheck } from '@/hooks/useVersionCheck'
import { t } from '@/i18n/translate'

export function VersionNotifier() {
  const { data, isSuccess } = useVersionCheck()
  const hasNotifiedRef = useRef(false)

  useEffect(() => {
    if (!isSuccess || !data || hasNotifiedRef.current) return

    if (data.updateAvailable && data.latestVersion && data.releaseUrl) {
      hasNotifiedRef.current = true
      showToast.info(t('OpenCode Manager v{version} is available', { version: data.latestVersion }), {
        description: t('A new version is ready to install.'),
        action: {
          label: t('View Release'),
          onClick: () => window.open(data.releaseUrl ?? '', '_blank'),
        },
        duration: 10000,
      })
    }
  }, [isSuccess, data])

  return null
}
