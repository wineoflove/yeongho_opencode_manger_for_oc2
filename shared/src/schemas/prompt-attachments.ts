import { z } from 'zod'

export const MAX_PROMPT_ATTACHMENT_BYTES = 500 * 1024 * 1024
export const PROMPT_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024
export const PromptUploadStartSchema = z.object({
  filename: z.string().min(1).max(1024),
  directory: z.string().min(1),
  size: z.number().int().min(1).max(MAX_PROMPT_ATTACHMENT_BYTES),
})
