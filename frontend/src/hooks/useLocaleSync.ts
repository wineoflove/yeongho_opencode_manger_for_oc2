import { useEffect } from 'react'
import { applyServerLocale } from '@/i18n/locale'
import { useSettings } from './useSettings'

export function useLocaleSync(): void {
  const locale = useSettings().preferences?.locale

  useEffect(() => {
    applyServerLocale(locale)
  }, [locale])
}
