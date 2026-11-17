import type { TokenStatsBucket, TokenStatsResponse } from '@opencode-manager/shared/schemas'
import { t } from '@/i18n/translate'
import {
  apiCost,
  formatCompactCost,
  formatCost,
  formatCostSplit,
  formatInteger,
  formatShare,
  formatTokens,
  ratio,
} from '@/lib/tokenStats'

export interface KpiDelta {
  readonly text: string
  readonly direction: 'up' | 'down' | 'flat'
}

export interface KpiCardData {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly title?: string
  readonly points: readonly number[]
  readonly delta?: KpiDelta
}

function shares(
  buckets: readonly TokenStatsBucket[],
  part: (bucket: TokenStatsBucket) => number,
  whole: (bucket: TokenStatsBucket) => number,
): number[] {
  return buckets.filter((bucket) => whole(bucket) > 0).map((bucket) => part(bucket) / whole(bucket))
}

function inputSide(bucket: Pick<TokenStatsBucket['tokens'], 'input' | 'cacheRead' | 'cacheWrite'>): number {
  return bucket.input + bucket.cacheRead + bucket.cacheWrite
}

export function buildKpiCards(data: TokenStatsResponse, delta?: KpiDelta): KpiCardData[] {
  const { totals, buckets } = data
  const input = inputSide(totals)
  const providerTotals = new Map<string, number>()
  for (const bucket of buckets) {
    for (const [key, total] of Object.entries(bucket.providers)) {
      providerTotals.set(key, (providerTotals.get(key) ?? 0) + total)
    }
  }
  const providers = [...providerTotals].map(([key, total]) => ({ key, total })).sort((a, b) => b.total - a.total)
  const providerTotal = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  return [
    {
      key: 'tokens',
      label: t('Tokens'),
      value: formatTokens(totals.total),
      detail: t('Input {input} · Output {output}', {
        input: formatTokens(input),
        output: formatTokens(totals.output + totals.reasoning),
      }),
      points: buckets.map((bucket) => bucket.total),
      delta,
    },
    {
      key: 'cost',
      label: t('Cost*'),
      value: formatCost(apiCost(totals)),
      detail:
        totals.estimatedCost > 0
          ? t('Recorded {recorded} · estimated {estimated}', {
              recorded: formatCompactCost(totals.cost),
              estimated: formatCompactCost(totals.estimatedCost),
            })
          : t('Recorded by OpenCode'),
      title: formatCostSplit(totals),
      points: buckets.map(apiCost),
    },
    {
      key: 'responses',
      label: t('Responses'),
      value: formatInteger(totals.messages),
      detail: t('{count} tokens per response', { count: formatTokens(ratio(totals.total, totals.messages)) }),
      points: buckets.map((bucket) => bucket.messages),
    },
    {
      key: 'cache',
      label: t('Cache hit rate'),
      value: formatShare(ratio(totals.cacheRead, input)),
      detail: t('Read {read} / input {input}', { read: formatTokens(totals.cacheRead), input: formatTokens(input) }),
      points: shares(
        buckets,
        (bucket) => bucket.tokens.cacheRead,
        (bucket) => inputSide(bucket.tokens),
      ),
    },
    ...providers.slice(0, 2).map((provider) => ({
      key: `provider:${provider.key}`,
      label: t('{provider} share', { provider: provider.key.toUpperCase() }),
      value: formatShare(ratio(provider.total, providerTotal)),
      detail: t('{part} of {total}', { part: formatTokens(provider.total), total: formatTokens(providerTotal) }),
      points: shares(
        buckets,
        (bucket) => bucket.providers[provider.key] ?? 0,
        (bucket) => bucket.total,
      ),
    })),
    {
      key: 'sessions',
      label: t('Sessions'),
      value: formatInteger(totals.sessions),
      detail: t('{count} tokens per session', { count: formatTokens(ratio(totals.total, totals.sessions)) }),
      points: buckets.map((bucket) => bucket.sessions),
    },
    {
      key: 'coverage',
      label: t('Account coverage'),
      value: totals.total > 0 ? formatShare(ratio(data.attribution.accountTokens, totals.total)) : '—',
      detail: `${formatTokens(data.attribution.accountTokens)} / ${formatTokens(totals.total)}`,
      points: shares(
        buckets,
        (bucket) => bucket.accountTokens,
        (bucket) => bucket.total,
      ),
    },
  ]
}
