import { z } from 'zod'
import { mapLegacyOpenAiCredentials } from './openai-credential-transfer'
import { snapshotOpenAiRateLimits } from './openai-rate-limit-snapshot'

const sourceSchema = z.object({
  settings: z.object({ rotationStrategy: z.string().optional() }).optional(),
  forcedAlias: z.string().nullable().optional(),
  accounts: z.record(
    z.string(),
    z.object({
      enabled: z.boolean().optional(),
      authInvalid: z.boolean().optional(),
      planType: z.string(),
      expiresAt: z.number().int().nonnegative(),
      usageCount: z.number().nonnegative().optional(),
      rateLimitedUntil: z.number().optional(),
      modelUnsupportedUntil: z.number().optional(),
      workspaceDeactivatedUntil: z.number().optional(),
      lastLimitErrorAt: z.number().optional(),
      authInvalidatedAt: z.number().optional(),
    }),
  ),
})

export class OpenAiRotationTransferError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_SELECTION_STATE'
      | 'INSUFFICIENT_TOKEN_LIFETIME'
      | 'INVALID_TIME_BUDGET'
      | 'INSUFFICIENT_STABLE_WINDOW',
  ) {
    super(code)
    this.name = 'OpenAiRotationTransferError'
  }
}

export function planOpenAiRotationTransfer(
  source: unknown,
  timing: {
    readonly now: number
    readonly executionBudgetMs: number
    readonly preserveRateLimits?: boolean
  },
) {
  if (
    !Number.isSafeInteger(timing.now) ||
    timing.now < 60000 ||
    !Number.isSafeInteger(timing.executionBudgetMs) ||
    timing.executionBudgetMs <= 0 ||
    !Number.isSafeInteger(timing.now + timing.executionBudgetMs + 300000)
  )
    throw new OpenAiRotationTransferError('INVALID_TIME_BUDGET')
  const parsed = sourceSchema.safeParse(source)
  if (!parsed.success) throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
  const state = parsed.data
  if ((state.settings?.rotationStrategy ?? 'round-robin') !== 'round-robin' || state.forcedAlias)
    throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
  const accounts = Object.values(state.accounts)
  for (const account of accounts) {
    const futureRateLimit = account.rateLimitedUntil !== undefined && account.rateLimitedUntil > timing.now
    if (
      account.enabled === false ||
      account.usageCount === 0 ||
      account.authInvalid ||
      account.planType.trim().toLowerCase() !== 'pro' ||
      [
        ...(timing.preserveRateLimits && futureRateLimit ? [] : [account.rateLimitedUntil]),
        account.modelUnsupportedUntil,
        account.workspaceDeactivatedUntil,
      ].some((time) => time !== undefined && time > timing.now - 10000) ||
      [account.lastLimitErrorAt, account.authInvalidatedAt].some(
        (time) => time !== undefined && time > timing.now - 60000,
      )
    )
      throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
    if (
      timing.preserveRateLimits &&
      futureRateLimit &&
      account.rateLimitedUntil !== undefined &&
      account.rateLimitedUntil <= timing.now + timing.executionBudgetMs + 300000
    )
      throw new OpenAiRotationTransferError('INSUFFICIENT_STABLE_WINDOW')
    if (account.expiresAt <= timing.now + timing.executionBudgetMs + 300000)
      throw new OpenAiRotationTransferError('INSUFFICIENT_TOKEN_LIFETIME')
  }
  const mapped = mapLegacyOpenAiCredentials(source)
  const ids = mapped.poolMembership.map((entry) => entry.credentialID)
  const eligibleIDs = mapped.credentials
    .filter((entry) => (state.accounts[entry.label]?.rateLimitedUntil ?? 0) <= timing.now)
    .map((entry) => entry.id)
  if (!eligibleIDs.length && !timing.preserveRateLimits)
    throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
  const selectable = eligibleIDs.length ? eligibleIDs : ids
  const nextCredentialID = selectable[mapped.legacyRotationIndex % selectable.length]
  if (!nextCredentialID) throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
  const nextIndex = ids.indexOf(nextCredentialID)
  const previousCredentialID = ids[(nextIndex + ids.length - 1) % ids.length]
  if (!previousCredentialID || !nextCredentialID) throw new OpenAiRotationTransferError('UNSUPPORTED_SELECTION_STATE')
  return {
    pool: { strategy: 'round-robin' as const, accounts: mapped.poolMembership },
    cursor: {
      key: 'ocm/account-pool/cursor/openai',
      value: { version: 1, credentialID: previousCredentialID },
    },
    nextCredentialID,
    sourceContentSha256: mapped.sourceContentSha256,
    assessedAt: timing.now,
    validUntil: Math.min(
      ...accounts.map((account) => account.expiresAt - 300000),
      ...accounts.flatMap((account) =>
        timing.preserveRateLimits && account.rateLimitedUntil !== undefined && account.rateLimitedUntil > timing.now
          ? [account.rateLimitedUntil - 300000]
          : [],
      ),
    ),
    eligibilityScope: timing.preserveRateLimits
      ? ('enabled-pro-with-preserved-rate-limits' as const)
      : ('enabled-healthy-pro-accounts-with-equal-priority' as const),
    ...(timing.preserveRateLimits
      ? {
          accountStates: snapshotOpenAiRateLimits(source, timing.now).entries,
          eligibilityChangePolicy: 'native-round-robin' as const,
        }
      : {}),
    runtimeSelectionVerified: false as const,
    refreshOwnershipTransferred: false as const,
    executable: false as const,
  }
}
