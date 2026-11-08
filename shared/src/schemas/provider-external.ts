import { z } from 'zod'

export const ProviderExternalLoginRequestSchema = z.object({}).strict()

export const ProviderExternalLoginResponseSchema = z.object({
  integrationID: z.literal('claude-agent'),
  methodID: z.literal('claude-login'),
  available: z.boolean(),
  status: z.enum(['connected', 'needs_auth', 'unconnected', 'unavailable']),
  connectionScope: z.literal('current_host_login'),
  supportsMultipleAccounts: z.literal(false),
  instructions: z.object({
    command: z.literal('claude auth login'),
    location: z.literal('opencode_host'),
    message: z.string(),
  }),
})

export type ProviderExternalLoginResponse = z.infer<typeof ProviderExternalLoginResponseSchema>
