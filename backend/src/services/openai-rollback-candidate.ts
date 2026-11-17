import { z } from 'zod'
import { mapLegacyOpenAiCredentials } from './openai-credential-transfer'
import { openAiNativeHealthSchema } from './openai-native-health'

const legacySchema = z
  .object({
    accounts: z.record(
      z.string(),
      z
        .object({
          rateLimitedUntil: z.number().finite().nonnegative().optional(),
          authInvalid: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
const nativeSchema = z.array(
  z.object({
    id: z.string().min(1),
    integrationID: z.literal('openai'),
    value: z.object({
      type: z.literal('oauth'),
      methodID: z.literal('chatgpt-browser'),
      access: z.string().min(1),
      refresh: z.string().min(1),
      expires: z.number().int().nonnegative(),
      metadata: z.object({ accountID: z.string().min(1) }),
    }),
  }),
)

export class OpenAiRollbackCandidateError extends Error {
  constructor(readonly code: 'LEGACY_SOURCE_INVALID' | 'NATIVE_CREDENTIALS_INVALID' | 'NATIVE_POOL_PAUSED') {
    super(code)
    this.name = 'OpenAiRollbackCandidateError'
  }
}

export function prepareOpenAiRollbackCandidate(source: unknown, nativeEntries: unknown) {
  const plan = (() => {
    try {
      return mapLegacyOpenAiCredentials(source)
    } catch {
      throw new OpenAiRollbackCandidateError('LEGACY_SOURCE_INVALID')
    }
  })()
  const legacy = legacySchema.safeParse(source)
  if (!legacy.success) throw new OpenAiRollbackCandidateError('LEGACY_SOURCE_INVALID')
  const native = z
    .union([
      nativeSchema,
      z
        .object({
          version: z.literal(1),
          credentials: nativeSchema,
          health: openAiNativeHealthSchema,
        })
        .strict(),
    ])
    .safeParse(nativeEntries)
  if (!native.success) throw new OpenAiRollbackCandidateError('NATIVE_CREDENTIALS_INVALID')
  const credentials = Array.isArray(native.data) ? native.data : native.data.credentials
  const health = Array.isArray(native.data) ? undefined : native.data.health
  if (credentials.length !== plan.credentials.length)
    throw new OpenAiRollbackCandidateError('NATIVE_CREDENTIALS_INVALID')
  const byID = new Map(credentials.map((entry) => [entry.id, entry.value]))
  if (byID.size !== credentials.length) throw new OpenAiRollbackCandidateError('NATIVE_CREDENTIALS_INVALID')
  if (health?.paused || health?.accounts.some((entry) => entry.state.failure === 'access-denied'))
    throw new OpenAiRollbackCandidateError('NATIVE_POOL_PAUSED')
  const states = new Map((health?.accounts ?? []).map((entry) => [entry.credentialID, entry.state]))
  if (states.size !== (health?.accounts.length ?? 0) || [...states.keys()].some((id) => !byID.has(id)))
    throw new OpenAiRollbackCandidateError('NATIVE_CREDENTIALS_INVALID')
  const accounts = Object.fromEntries(
    plan.credentials.map((original) => {
      const current = byID.get(original.id)
      if (!current || current.metadata.accountID !== original.value.metadata.accountID)
        throw new OpenAiRollbackCandidateError('NATIVE_CREDENTIALS_INVALID')
      const previous = legacy.data.accounts[original.label]
      const state = states.get(original.id)
      const cooldown = state?.cooldownUntil
      const authInvalid = state?.authInvalid === true || state?.failure === 'authentication'
      return [
        original.label,
        {
          ...previous,
          accessToken: current.access,
          refreshToken: current.refresh,
          expiresAt: current.expires,
          ...(cooldown !== undefined
            ? {
                rateLimitedUntil: Math.max(previous?.rateLimitedUntil ?? 0, cooldown),
              }
            : {}),
          ...(authInvalid ? { authInvalid: true } : {}),
        },
      ]
    }),
  )
  return {
    store: { ...legacy.data, accounts },
    phase: 'rollback-candidate-only' as const,
    refreshOwnershipTransferred: false as const,
    executable: false as const,
    nativeHealthIncluded: health !== undefined,
  }
}
