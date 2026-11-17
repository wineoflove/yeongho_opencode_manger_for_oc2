import { z } from 'zod'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

const PROXY_URL = `${API_BASE_URL}/api/providers/claude-proxy`
const LOGIN_COMPLETION_TIMEOUT_MS = 60_000

const timestampSchema = z.string().datetime({ offset: true })
const providerSchema = z.enum(['claude', 'openai'])
const ownershipSchema = z.object({
  configured: z.boolean(),
  ownsInference: z.boolean(),
})
const accountSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  provider: providerSchema,
  label: z.string().nullable(),
  enabled: z.boolean(),
  available: z.boolean(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  lastRefreshedAt: timestampSchema.nullable(),
  nextRetryAt: timestampSchema.nullable(),
})
const accountsSchema = z.object({
  configured: z.literal(true),
  observedAt: timestampSchema,
  accounts: z.array(accountSchema),
})
const loginSchema = z.object({
  provider: providerSchema,
  state: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  expiresAt: timestampSchema,
})
const confirmationSchema = z.object({ status: z.literal('ok') })

/** Upstream service whose accounts CLIProxy rotates. */
export type ClaudeProxyProvider = z.infer<typeof providerSchema>

/** One CLIProxy account without any credential material. */
export type ClaudeProxyAccount = z.infer<typeof accountSchema>

/** A started CLIProxy sign-in whose redirect must be submitted before `expiresAt`. */
export type ClaudeProxyLogin = z.infer<typeof loginSchema>

/** The redirect address that finishes a started sign-in. */
export interface ClaudeProxyLoginCompletion {
  readonly provider: ClaudeProxyProvider
  readonly state: string
  readonly redirectUrl: string
}

function accountUrl(id: string): string {
  return `${PROXY_URL}/accounts/${encodeURIComponent(id)}`
}

function jsonRequest(method: 'POST' | 'PATCH', body: object): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const claudeProxyApi = {
  async status() {
    return ownershipSchema.parse(await fetchWrapper(`${PROXY_URL}/status`))
  },
  async accounts() {
    return accountsSchema.parse(await fetchWrapper(`${PROXY_URL}/accounts`))
  },
  async startLogin(provider: ClaudeProxyProvider) {
    return loginSchema.parse(await fetchWrapper(`${PROXY_URL}/logins`, jsonRequest('POST', { provider })))
  },
  async completeLogin(completion: ClaudeProxyLoginCompletion) {
    return confirmationSchema.parse(
      await fetchWrapper(`${PROXY_URL}/logins/complete`, {
        ...jsonRequest('POST', completion),
        timeout: LOGIN_COMPLETION_TIMEOUT_MS,
      }),
    )
  },
  async setAccountEnabled(id: string, enabled: boolean) {
    return confirmationSchema.parse(await fetchWrapper(accountUrl(id), jsonRequest('PATCH', { enabled })))
  },
  async deleteAccount(id: string) {
    return confirmationSchema.parse(await fetchWrapper(accountUrl(id), { method: 'DELETE' }))
  },
}
