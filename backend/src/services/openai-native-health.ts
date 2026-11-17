import { z } from 'zod'

export const openAiAccountHealthSchema = z
  .object({
    version: z.literal(1),
    failure: z.enum(['access-denied', 'authentication', 'rate-limited', 'service', 'transport', 'unknown']),
    observedAt: z.number().finite().nonnegative(),
    cooldownUntil: z.number().finite().nonnegative().optional(),
    authInvalid: z.boolean().optional(),
  })
  .strict()

export const openAiNativeHealthSchema = z
  .object({
    paused: z.boolean(),
    accounts: z.array(
      z
        .object({
          credentialID: z.string().min(1),
          state: openAiAccountHealthSchema,
        })
        .strict(),
    ),
  })
  .strict()
