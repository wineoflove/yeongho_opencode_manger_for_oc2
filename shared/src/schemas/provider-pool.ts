import { z } from 'zod'

export const ProviderPoolStatusSchema = z.object({
  integrationID: z.string().min(1),
  enabled: z.boolean(),
  strategy: z.literal('round-robin').nullable(),
  paused: z.boolean(),
  lastSelectedCredentialID: z.string().nullable(),
  accounts: z.array(
    z.object({
      credentialID: z.string().min(1),
      enabled: z.boolean(),
      failure: z
        .enum(['access-denied', 'authentication', 'rate-limited', 'service', 'transport', 'unknown'])
        .nullable(),
      authInvalid: z.boolean(),
      cooldownUntil: z.number().finite().nonnegative().nullable(),
      observedAt: z.number().finite().nonnegative().nullable(),
    }),
  ),
})

export const ProviderPoolResponseSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(false) }),
  z.object({
    supported: z.literal(true),
    status: ProviderPoolStatusSchema,
    configRevision: z.string().optional(),
  }),
])

export type ProviderPoolResponse = z.infer<typeof ProviderPoolResponseSchema>

export const ProviderPoolConfigureSchema = z
  .object({
    expectedRevision: z.string().min(1),
    accounts: z.array(z.object({ credentialID: z.string().min(1), enabled: z.boolean() }).strict()).max(20),
  })
  .strict()
  .refine(
    (value) => new Set(value.accounts.map((account) => account.credentialID)).size === value.accounts.length,
    'Duplicate account IDs',
  )
