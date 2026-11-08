import { z } from 'zod'

export const ProviderAccountSchema = z.object({
  id: z.string(),
  integrationID: z.string(),
  label: z.string(),
  active: z.boolean(),
  type: z.enum(['key', 'oauth', 'external']),
  methodID: z.string().nullable(),
})

export const ProviderAccountsResponseSchema = z.object({
  accounts: z.array(ProviderAccountSchema),
})
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>

export const ProviderAccountRenameRequestSchema = z.object({ label: z.string().trim().min(1).max(120) }).strict()

export const ProviderAccountActivationResponseSchema = z.object({
  success: z.literal(true),
  activeAccountId: z.string(),
})
export const ProviderAccountRenameResponseSchema = z.object({
  success: z.literal(true),
  accountId: z.string(),
  label: z.string(),
})
export const ProviderAccountDeletionResponseSchema = z.object({
  success: z.literal(true),
  deletedAccountId: z.string(),
})
