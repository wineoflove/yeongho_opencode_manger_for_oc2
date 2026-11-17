import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

const settingsSchema = z.record(z.string(), z.unknown())
const providerSchema = z.object({ settings: settingsSchema.optional() }).passthrough()
const configSchema = z
  .object({
    provider: z.never().optional(),
    plugin: z.never().optional(),
    providers: z.record(z.string(), z.unknown()).optional(),
    plugins: z
      .array(z.union([z.string(), z.object({ package: z.string(), options: settingsSchema.optional() }).strict()]))
      .optional(),
  })
  .passthrough()
const poolSchema = z
  .object({
    strategy: z.literal('round-robin'),
    accounts: z
      .array(
        z
          .object({
            credentialID: z.string().regex(/^cred_oc1_[a-f0-9]{32}$/),
            enabled: z.literal(true),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()

export class OpenAiPoolConfigError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_POOL' | 'CONFLICTING_SETTINGS') {
    super(code)
    this.name = 'OpenAiPoolConfigError'
  }
}

export function prepareOpenAiPoolConfig(config: unknown, plannedPool: unknown) {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) throw new OpenAiPoolConfigError('INVALID_CONFIG')
  const pool = poolSchema.safeParse(plannedPool)
  if (
    !pool.success ||
    new Set(pool.data.accounts.map((account) => account.credentialID)).size !== pool.data.accounts.length
  )
    throw new OpenAiPoolConfigError('INVALID_POOL')
  const provider = providerSchema.safeParse(parsed.data.providers?.openai ?? {})
  if (!provider.success) throw new OpenAiPoolConfigError('INVALID_CONFIG')
  const settings = provider.data.settings ?? {}
  if (
    ['apiKey', 'accessToken', 'authToken', 'credentialID'].some((key) => Object.hasOwn(settings, key)) ||
    (settings.accountPool !== undefined && !isDeepStrictEqual(settings.accountPool, pool.data))
  )
    throw new OpenAiPoolConfigError('CONFLICTING_SETTINGS')
  const plugins = parsed.data.plugins?.filter(
    (entry) => (typeof entry === 'string' ? entry : entry.package) !== '@guard22/opencode-multi-auth-codex@1.4.3',
  )
  return {
    config: {
      ...parsed.data,
      ...(plugins === undefined ? {} : { plugins }),
      providers: {
        ...parsed.data.providers,
        openai: {
          ...provider.data,
          settings: { ...settings, accountPool: pool.data },
        },
      },
    },
    removedLegacyCodexRegistrations: (parsed.data.plugins?.length ?? 0) - (plugins?.length ?? 0),
    targetMustStayStopped: true,
    refreshOwnershipTransferred: false,
  }
}
