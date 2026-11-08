import { useSessionPermissionMode, useSetSessionPermissionMode } from '@/hooks/useSessionPermissionMode'
import { t } from '@/i18n/translate'

export function usePermissionModeToggle(
  sessionID: string,
  directory: string,
  options: { enabled?: boolean } = {},
) {
  const { data, isError } = useSessionPermissionMode(sessionID, options)
  const setMode = useSetSessionPermissionMode(sessionID)

  const loaded = data !== undefined
  const isAuto = data?.mode === 'auto'
  const lockedReason = data?.lockedReason ?? null
  const disabled = !loaded || lockedReason !== null || setMode.isPending

  const label = !loaded
    ? isError
      ? t('Permissions: unavailable')
      : t('Permissions: loading')
    : lockedReason === 'child'
      ? t('Inherited from parent session')
      : lockedReason === 'schedule'
        ? t("Scheduled runs use the schedule's permission configuration")
        : isAuto
          ? t('Permissions: auto-accept all')
          : t('Permissions: follow configured rules')

  const toggle = () => {
    if (disabled) return
    setMode.mutate({ directory, mode: isAuto ? 'ask' : 'auto' })
  }

  return { isAuto, disabled, label, toggle }
}
