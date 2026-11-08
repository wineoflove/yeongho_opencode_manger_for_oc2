import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PROVIDER_RATE_LIMIT_STALE_MS } from '@opencode-manager/shared/schemas'
import { getProviderRateLimits } from '@/api/provider-rate-limits'
import { Button } from '@/components/ui/button'
import { t, msg } from '@/i18n/translate'
import { getLocale } from '@/i18n/locale'

const windowLabels = {
  five_hour: msg('5-hour window'),
  seven_day: msg('7-day window'),
  seven_day_overage_included: msg('7-day window (overage included)'),
} as const

const subscriptionStatusLabels: Record<string, string> = {
  allowed: msg('Allowed'),
  allowed_warning: msg('Warning'),
  rejected: msg('Rejected'),
}

/** Localized label for a reported subscription status, keeping unknown provider tokens verbatim. */
function subscriptionStatusLabel(status: string): string {
  return Object.hasOwn(subscriptionStatusLabels, status) ? t(subscriptionStatusLabels[status] as string) : status
}

const resourceLabels = {
  requests: msg('Requests'),
  tokens: msg('Tokens'),
  'input-tokens': msg('Input tokens'),
  'output-tokens': msg('Output tokens'),
} as const

export function ProviderRateLimits({ providerId }: { readonly providerId: string }) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['provider-rate-limits', providerId],
    queryFn: () => getProviderRateLimits(providerId),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
    retry: false,
  })
  return (
    <details className="mt-3 border-t border-border pt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {t('API limit observations')}
      </summary>
      {open && (
        <div className="space-y-3 py-2 text-sm">
          <p className="break-keep text-muted-foreground">
            {t(
              'HTTP header observations. Subscription usage appears only when the provider reports it in response headers. Account attribution is unknown. Values are cleared when Manager restarts.',
            )}
          </p>
          <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {t('Refresh observations')}
          </Button>
          {query.isPending && <p role="status">{t('Loading limit observations…')}</p>}
          {query.isError && (
            <p role="alert">
              {t('Could not load limit observations. This does not indicate an authentication or quota failure.')}
            </p>
          )}
          {!query.isPending && !query.isError && query.data?.observations.length === 0 && (
            <p>{t('No HTTP limit headers have been observed. Collection may be inactive or unavailable.')}</p>
          )}
          {query.data?.observations.map((observation) => (
            <section
              key={observation.modelId}
              className="space-y-1 border-t border-border py-2"
              aria-label={observation.modelId}
            >
              <p className="break-words font-medium">{observation.modelId}</p>
              <p className="text-muted-foreground">
                {t('Observed at {time}', {
                  time: new Date(observation.observedAt).toLocaleString(getLocale()),
                })}
              </p>
              {(observation.stale || Date.now() - observation.observedAt > PROVIDER_RATE_LIMIT_STALE_MS) && (
                <p>{t('Stale observation — current remaining capacity is unknown.')}</p>
              )}
              {observation.status === 'partial' && <p>{t('Some limit headers could not be parsed.')}</p>}
              {(observation.subscriptionWindows.length > 0 || observation.subscriptionStatus !== null) && (
                <div className="space-y-1" data-testid="subscription-usage">
                  <p className="font-medium">
                    {t('Subscription usage')}
                    {observation.subscriptionStatus !== null &&
                      ` · ${subscriptionStatusLabel(observation.subscriptionStatus)}`}
                  </p>
                  <dl className="space-y-1">
                    {observation.subscriptionWindows.map((window) => (
                      <div key={window.window} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                        <dt>{t(windowLabels[window.window])}</dt>
                        <dd className="tabular-nums">
                          {window.usedPercent === null
                            ? t('Unknown')
                            : t('Used {percent}%', { percent: window.usedPercent })}
                          {window.status !== null && ` · ${subscriptionStatusLabel(window.status)}`}
                        </dd>
                        {window.resetAt !== null && (
                          <dd className="w-full text-muted-foreground">
                            {t('Reset at {time}', {
                              time: new Date(window.resetAt).toLocaleString(getLocale()),
                            })}
                          </dd>
                        )}
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              <dl className="space-y-1">
                {observation.buckets.map((bucket) => (
                  <div key={bucket.resource} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt>{t(resourceLabels[bucket.resource])}</dt>
                    <dd className="tabular-nums">
                      {t('Remaining {remaining} / limit {limit}', {
                        remaining:
                          bucket.remaining === null
                            ? t('Unknown')
                            : bucket.remainingRounded
                              ? t('About {value}', {
                                  value: bucket.remaining.toLocaleString(getLocale()),
                                })
                              : bucket.remaining.toLocaleString(getLocale()),
                        limit: bucket.limit === null ? t('Unknown') : bucket.limit.toLocaleString(getLocale()),
                      })}
                    </dd>
                    {bucket.resetAt !== null && (
                      <dd className="w-full text-muted-foreground">
                        {t('Reset at {time}', {
                          time: new Date(bucket.resetAt).toLocaleString(getLocale()),
                        })}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
              {observation.retryAfterSeconds !== null && (
                <p>
                  {t('Observed retry-after: {seconds} seconds', {
                    seconds: observation.retryAfterSeconds,
                  })}
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </details>
  )
}
