import { createHash } from 'node:crypto'
import { z } from 'zod'

const accountSchema = z
  .object({
    accountId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    enabled: z.boolean().default(true),
  })
  .passthrough()
const storeSchema = z
  .object({
    version: z.literal(2),
    accounts: z.record(z.string().min(1), accountSchema),
    activeAlias: z.string().min(1),
    rotationIndex: z.number().int().nonnegative(),
  })
  .passthrough()

export class OpenAiTransferPlanError extends Error {
  constructor(
    readonly code: 'INVALID_SOURCE' | 'DUPLICATE_ACCOUNT' | 'ACTIVE_ACCOUNT_UNAVAILABLE' | 'UNSUPPORTED_ACCOUNT_COUNT',
  ) {
    super(code)
    this.name = 'OpenAiTransferPlanError'
  }
}

export function mapLegacyOpenAiCredentials(source: unknown) {
  const parsed = storeSchema.safeParse(source)
  if (!parsed.success) throw new OpenAiTransferPlanError('INVALID_SOURCE')
  const store = parsed.data
  const entries = Object.entries(store.accounts)
  if (!entries.length || entries.length > 20) throw new OpenAiTransferPlanError('UNSUPPORTED_ACCOUNT_COUNT')
  const identities = new Set<string>()
  const credentials = entries.map(([alias, account]) => {
    if (identities.has(account.accountId)) throw new OpenAiTransferPlanError('DUPLICATE_ACCOUNT')
    identities.add(account.accountId)
    const id = `cred_oc1_${createHash('sha256').update(account.accountId).digest('hex').slice(0, 32)}`
    return {
      id,
      integrationID: 'openai' as const,
      label: alias,
      activate: false as const,
      value: {
        type: 'oauth' as const,
        methodID: 'chatgpt-browser',
        access: account.accessToken,
        refresh: account.refreshToken,
        expires: account.expiresAt,
        metadata: { accountID: account.accountId },
      },
    }
  })
  const active = credentials.find((entry) => entry.label === store.activeAlias)
  if (!active || store.accounts[store.activeAlias]?.enabled !== true)
    throw new OpenAiTransferPlanError('ACTIVE_ACCOUNT_UNAVAILABLE')
  const poolMembership = entries.map(([, account], index) => {
    const credential = credentials[index]
    if (!credential) throw new OpenAiTransferPlanError('INVALID_SOURCE')
    return { credentialID: credential.id, enabled: account.enabled }
  })
  return {
    credentials,
    activeCredentialID: active.id,
    poolMembership,
    legacyRotationIndex: store.rotationIndex,
    sourceContentSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    sourceArchiveRequired: true as const,
    targetMustStayStopped: true as const,
    nativeInactiveCreationGuaranteed: false as const,
    selectionPolicyVerified: false as const,
    refreshOwnershipTransferred: false as const,
    executable: false as const,
  }
}
