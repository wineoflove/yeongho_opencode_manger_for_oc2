import { z } from 'zod'

export const TelegramSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  hasBotToken: z.boolean(),
  chatId: z.string(),
  publicUrl: z.string(),
  source: z.enum(['db', 'env', 'none']),
})

export const UpdateTelegramSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    botToken: z.string().optional(),
    chatId: z.string(),
    publicUrl: z.string(),
  })
  .strict()

export const TelegramTestNotificationResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['sent', 'not_configured', 'failed']),
})

export type TelegramSettingsResponse = z.infer<typeof TelegramSettingsResponseSchema>
export type UpdateTelegramSettingsRequest = z.infer<typeof UpdateTelegramSettingsRequestSchema>
export type TelegramTestNotificationResponse = z.infer<typeof TelegramTestNotificationResponseSchema>
