import type { Model } from '@/api/providers'
import { formatCompactTokens } from '@/lib/contextUsage'
import { msg, t } from '@/i18n/translate'

const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const STATUS_LABELS: Record<NonNullable<Model['status']>, string | null> = {
  active: null,
  alpha: msg('Alpha'),
  beta: msg('Beta'),
  deprecated: msg('Deprecated'),
}

/** Localized release-status label for a model that is not generally available, or null when it is. */
export function modelStatusLabel(model: Model | undefined): string | null {
  const label = model?.status ? STATUS_LABELS[model.status] : null
  return label ? t(label) : null
}

/** Provider, context window, base price per million tokens and notable capabilities as one summary line. */
export function describeModel(providerName: string, model: Model | undefined): string {
  const parts = [providerName]
  const context = model?.limit?.context
  if (context) parts.push(t('{tokens} context', { tokens: formatCompactTokens(context) }))
  if (model?.free) parts.push(t('Free'))
  else if (model?.price) {
    parts.push(
      t('{input} / {output} per 1M', {
        input: PRICE_FORMAT.format(model.price.input),
        output: PRICE_FORMAT.format(model.price.output),
      }),
    )
  }
  if (model?.tools) parts.push(t('Tools'))
  if (model?.attachments) parts.push(t('Files'))
  return parts.join(' · ')
}
