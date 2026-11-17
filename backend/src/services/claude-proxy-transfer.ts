import { createHash } from 'node:crypto'
import { z } from 'zod'

const tokenSchema = z
  .object({
    type: z.literal('oauth'),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number().finite(),
  })
  .passthrough()
const accountSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]+$/),
    label: z.string(),
    enabled: z.boolean(),
    status: z.enum(['ok', 'auth-invalid', 'rate-limited', 'service']),
    cooldownUntil: z.number().finite(),
    credentials: tokenSchema,
  })
  .passthrough()
const poolSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    paused: z.boolean(),
    accounts: z.array(accountSchema).min(1).max(20),
    blockedRequests: z.array(z.unknown()),
  })
  .passthrough()
const proxySchema = z.object({
  type: z.literal('claude'),
  account_uuid: z.string().uuid(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expired: z.string().datetime({ offset: true }),
  disabled: z.boolean().default(false),
})
const identitySchema = z.record(z.string(), z.string().uuid())
const ledgerSchema = z.object({
  version: z.literal(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z
    .array(
      z.object({
        sourceID: z.string(),
        proxyFile: z.string(),
        accountUUID: z.string().uuid(),
      }),
    )
    .min(1),
})

export type ClaudeTransferLedger = z.infer<typeof ledgerSchema>
export class ClaudeTransferError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'SOURCE_CHANGED' | 'SOURCE_BLOCKED' | 'ACCOUNT_MISMATCH') {
    super(code)
    this.name = 'ClaudeTransferError'
  }
}

function parsePool(text: string) {
  try {
    const pool = poolSchema.parse(JSON.parse(text))
    if (
      pool.accounts[0]?.id !== 'main' ||
      new Set(pool.accounts.map((entry) => entry.id)).size !== pool.accounts.length
    )
      throw new ClaudeTransferError('INVALID_INPUT')
    return pool
  } catch (error) {
    if (error instanceof Error) throw new ClaudeTransferError('INVALID_INPUT')
    throw error
  }
}

export { parsePool as parseClaudeTransferPool }

export function planClaudeTransfer(source: string, identities: unknown) {
  const pool = parsePool(source)
  const parsed = identitySchema.safeParse(identities)
  if (!parsed.success) throw new ClaudeTransferError('INVALID_INPUT')
  if (
    pool.paused ||
    pool.blockedRequests.length ||
    pool.accounts.some((account) => account.enabled && (account.status !== 'ok' || account.cooldownUntil > Date.now()))
  )
    throw new ClaudeTransferError('SOURCE_BLOCKED')
  const ids = pool.accounts.map((account) => account.id)
  if (
    Object.keys(parsed.data).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(parsed.data, id)) ||
    new Set(Object.values(parsed.data)).size !== ids.length
  )
    throw new ClaudeTransferError('ACCOUNT_MISMATCH')
  const entries = pool.accounts.map((account) => {
    const accountUUID = parsed.data[account.id]
    if (!accountUUID) throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    return {
      sourceID: account.id,
      proxyFile: `legacy-${account.id}.json`,
      accountUUID,
    }
  })
  const files = pool.accounts.map((account, index) => {
    const entry = entries[index]
    if (!entry) throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    return {
      name: entry.proxyFile,
      value: {
        type: 'claude',
        account_uuid: entry.accountUUID,
        access_token: account.credentials.access,
        refresh_token: account.credentials.refresh,
        expired: new Date(account.credentials.expires).toISOString(),
        disabled: !account.enabled,
      },
    }
  })
  const ledger: ClaudeTransferLedger = {
    version: 1,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    entries,
  }
  return { ledger, files }
}

export function assertLegacyAuthMatchesPool(source: string, authText: string): void {
  const pool = parsePool(source)
  let auth: unknown
  try {
    auth = JSON.parse(authText)
  } catch {
    throw new ClaudeTransferError('INVALID_INPUT')
  }
  const parsed = z.object({ anthropic: tokenSchema }).safeParse(auth)
  if (!parsed.success) throw new ClaudeTransferError('INVALID_INPUT')
  const main = pool.accounts.find((entry) => entry.id === 'main')?.credentials
  if (
    !main ||
    main.access !== parsed.data.anthropic.access ||
    main.refresh !== parsed.data.anthropic.refresh ||
    main.expires !== parsed.data.anthropic.expires
  )
    throw new ClaudeTransferError('ACCOUNT_MISMATCH')
}

export function restoreClaudeTransfer(source: string, ledgerInput: unknown, currentFiles: unknown): string {
  const ledgerResult = ledgerSchema.safeParse(ledgerInput)
  const filesResult = z.record(z.string(), proxySchema).safeParse(currentFiles)
  if (!ledgerResult.success || !filesResult.success) throw new ClaudeTransferError('INVALID_INPUT')
  const ledger = ledgerResult.data
  if (createHash('sha256').update(source).digest('hex') !== ledger.sourceSha256)
    throw new ClaudeTransferError('SOURCE_CHANGED')
  const pool = parsePool(source)
  if (
    ledger.entries.length !== pool.accounts.length ||
    Object.keys(filesResult.data).length !== pool.accounts.length ||
    new Set(ledger.entries.map((entry) => entry.sourceID)).size !== pool.accounts.length ||
    new Set(ledger.entries.map((entry) => entry.proxyFile)).size !== pool.accounts.length
  )
    throw new ClaudeTransferError('ACCOUNT_MISMATCH')
  const accounts = pool.accounts.map((account) => {
    const entry = ledger.entries.find((item) => item.sourceID === account.id)
    if (!entry || entry.proxyFile !== `legacy-${account.id}.json`) throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    const current = filesResult.data[entry.proxyFile]
    if (current && current.disabled === account.enabled) throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    if (!current || current.account_uuid !== entry.accountUUID) throw new ClaudeTransferError('ACCOUNT_MISMATCH')
    return {
      ...account,
      credentials: {
        ...account.credentials,
        access: current.access_token,
        refresh: current.refresh_token,
        expires: Date.parse(current.expired),
      },
    }
  })
  return JSON.stringify({ ...pool, accounts })
}
