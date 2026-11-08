import { z } from 'zod'

export const MAX_PROMPT_ATTACHMENT_BYTES = 500 * 1024 * 1024
export const PROMPT_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024
export const PromptAttachmentSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/)
export const PromptUploadStartSchema = z.object({
  filename: z.string().min(1).max(1024),
  directory: z.string().min(1),
  size: z.number().int().min(1).max(MAX_PROMPT_ATTACHMENT_BYTES),
  sessionID: PromptAttachmentSessionIdSchema.optional(),
})

/**
 * Sidecar record written next to each stored upload so the uploads screen can show the original
 * filename, upload time and the session that received the file.
 */
export const PromptAttachmentMetadataSchema = z.object({
  filename: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  uploadedAt: z.number().int().nonnegative(),
  directory: z.string().min(1),
  sessionID: PromptAttachmentSessionIdSchema.optional(),
})
export type PromptAttachmentMetadata = z.infer<typeof PromptAttachmentMetadataSchema>

export const StoredPromptAttachmentSchema = z.object({
  id: z.string().regex(/^(?:file|zip)-[A-Za-z0-9]{6}$/),
  filename: z.string(),
  storedName: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  uploadedAt: z.number().int().nonnegative(),
  directory: z.string().nullable(),
  sessionID: z.string().nullable(),
  hasMetadata: z.boolean(),
})
export type StoredPromptAttachment = z.infer<typeof StoredPromptAttachmentSchema>

export const StoredPromptAttachmentListSchema = z.object({
  entries: z.array(StoredPromptAttachmentSchema),
  totalBytes: z.number().int().nonnegative(),
})
export type StoredPromptAttachmentList = z.infer<typeof StoredPromptAttachmentListSchema>
