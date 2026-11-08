import { useSessionSandbox, useSetSessionSandbox } from '@/hooks/useSessionSandbox'
import { t } from '@/i18n/translate'

export function useSandboxToggle(sessionID: string, options: { enabled?: boolean } = {}) {
  const { data, isError } = useSessionSandbox(sessionID, options)
  const setSandbox = useSetSessionSandbox(sessionID)

  const loaded = data !== undefined
  const isSandboxed = data?.sandboxed ?? false
  const available = data?.available ?? true
  const lockedReason = data?.lockedReason ?? null
  const resources = data?.resources ?? null
  const effectiveResources = data?.effectiveResources
  const disabled = !loaded || lockedReason !== null || setSandbox.isPending

  const label = !loaded
    ? isError
      ? t('Sandbox: unavailable')
      : t('Sandbox: loading')
    : lockedReason === 'child'
      ? t('Inherited from parent session')
      : isSandboxed
        ? t('Sandbox: commands run in a microVM')
        : t('Sandbox: commands run on the host')

  const toggle = () => {
    if (disabled) return
    setSandbox.mutate({ sandboxed: !isSandboxed })
  }

  return { isSandboxed, available, disabled, label, toggle, lockedReason, resources, effectiveResources }
}
