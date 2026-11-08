import { z } from 'zod'
import { fetchWrapper, fetchWrapperVoid } from './fetchWrapper'
import { API_BASE_URL } from '@/config'
import { msg } from '@/i18n/translate'
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  PROMPT_ATTACHMENT_CHUNK_BYTES,
  PromptAttachmentSessionIdSchema,
  StoredPromptAttachmentListSchema,
} from '@opencode-manager/shared/schemas'

const uploadedFileSchema = z.object({ path: z.string().min(1), size: z.number().nonnegative() })

const ATTACHMENTS_URL = `${API_BASE_URL}/api/files/attachments`

/**
 * Uploads a prompt file to the server store. The session id is recorded with the stored file only
 * when it is a real OpenCode session id, so drafts for not-yet-created sessions still upload.
 */
export async function uploadPromptFile(file: File, directory: string, sessionID?: string) {
  if (file.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(msg('Attachments must not exceed 500MB'))
  const session = PromptAttachmentSessionIdSchema.safeParse(sessionID)
  const recordedSession = session.success ? session.data : undefined
  if (file.size > PROMPT_ATTACHMENT_CHUNK_BYTES) return uploadChunks(file, directory, recordedSession)
  const body = new FormData()
  body.set('file', file)
  body.set('directory', directory)
  if (recordedSession) body.set('sessionID', recordedSession)
  return uploadedFileSchema.parse(
    await fetchWrapper(ATTACHMENTS_URL, {
      method: 'POST',
      body,
    }),
  )
}

async function uploadChunks(file: File, directory: string, sessionID: string | undefined) {
  const base = `${ATTACHMENTS_URL}/chunks`
  const { uploadId } = z.object({ uploadId: z.string().uuid() }).parse(
    await fetchWrapper(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, directory, size: file.size, sessionID }),
    }),
  )
  const url = `${base}/${uploadId}`
  try {
    for (let offset = 0; offset < file.size; offset += PROMPT_ATTACHMENT_CHUNK_BYTES) {
      const end = Math.min(file.size, offset + PROMPT_ATTACHMENT_CHUNK_BYTES)
      const result = z.object({ received: z.number().int() }).parse(
        await fetchWrapper(`${url}?offset=${offset}`, {
          method: 'PUT',
          body: file.slice(offset, end),
          timeout: 120000,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
      if (result.received !== end) throw new Error(msg('Upload offset mismatch'))
    }
    return uploadedFileSchema.parse(await fetchWrapper(`${url}/complete`, { method: 'POST' }))
  } catch (error) {
    try {
      await fetchWrapperVoid(url, { method: 'DELETE' })
    } catch {
      throw new Error(msg('Upload failed and partial-file cleanup could not be confirmed'), { cause: error })
    }
    throw error
  }
}

export async function listStoredPromptAttachments() {
  return StoredPromptAttachmentListSchema.parse(await fetchWrapper(ATTACHMENTS_URL))
}

export async function deleteStoredPromptAttachment(id: string) {
  await fetchWrapperVoid(`${ATTACHMENTS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function storedPromptAttachmentUrl(id: string, options: { readonly download?: boolean } = {}) {
  const url = `${ATTACHMENTS_URL}/${encodeURIComponent(id)}/content`
  return options.download ? `${url}?download=1` : url
}
