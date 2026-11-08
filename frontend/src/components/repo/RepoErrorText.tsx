import { describeError } from '@/i18n/errors'
import { getLocale } from '@/i18n/locale'
import { t } from '@/i18n/translate'

/** Shows a server error message localized: a translated message as is, otherwise a localized title above the original detail. */
export function RepoErrorText({ message }: { message: string }) {
  const translated = t(message)
  if (getLocale() === 'en' || translated !== message || !message) return translated
  const error = describeError(message)
  return (
    <>
      {error.title}
      <span className="block text-xs text-muted-foreground">{error.detail}</span>
    </>
  )
}
