import { randomUUID } from 'node:crypto'
import { appendFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { PromptUploadStartSchema, PROMPT_ATTACHMENT_CHUNK_BYTES } from '@opencode-manager/shared/schemas'
import { allocatePromptAttachment, writePromptAttachmentMetadata } from '../services/prompt-attachment-storage'

interface Upload {
  directory: string
  path: string
  filename: string
  sessionDirectory: string
  sessionID?: string
  partial: string
  size: number
  received: number
  busy: boolean
  expiresAt: number
}

const IDLE_EXPIRY_MS = 30 * 60 * 1000
const MAX_PENDING_UPLOADS = 16

export function createPromptAttachmentChunkRoutes() {
  const app = new Hono()
  const uploads = new Map<string, Upload>()
  let creating = 0

  app.use('*', async (_context, next) => {
    for (const [id, upload] of uploads) {
      if (!upload.busy && upload.expiresAt <= Date.now()) {
        upload.busy = true
        uploads.delete(id)
        await rm(upload.directory, { recursive: true, force: true })
      }
    }
    await next()
  })

  app.post('/', bodyLimit({ maxSize: 8192 }), async (context) => {
    const parsed = PromptUploadStartSchema.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success || !isAbsolute(parsed.data.directory))
      return context.json({ error: 'A filename, absolute directory and file size up to 500MB are required' }, 400)
    if (uploads.size + creating >= MAX_PENDING_UPLOADS) return context.json({ error: 'Too many pending uploads' }, 429)
    creating++
    try {
      const allocation = await allocatePromptAttachment(parsed.data.filename)
      if (!allocation) return context.json({ error: 'Attachment storage must not be redirected' }, 403)
      const partial = join(allocation.directory, 'upload.part')
      try {
        await writeFile(partial, new Uint8Array(), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        await rm(allocation.directory, { recursive: true, force: true })
        throw error
      }
      const uploadId = randomUUID()
      uploads.set(uploadId, {
        ...allocation,
        filename: parsed.data.filename,
        sessionDirectory: parsed.data.directory,
        sessionID: parsed.data.sessionID,
        partial,
        size: parsed.data.size,
        received: 0,
        busy: false,
        expiresAt: Date.now() + IDLE_EXPIRY_MS,
      })
      return context.json({ uploadId })
    } finally {
      creating--
    }
  })

  app.put('/:id', bodyLimit({ maxSize: PROMPT_ATTACHMENT_CHUNK_BYTES }), async (context) => {
    const upload = uploads.get(context.req.param('id'))
    if (!upload) return context.json({ error: 'Upload expired or not found' }, 404)
    const offset = context.req.query('offset')
    if (upload.busy || offset === undefined || !/^\d+$/.test(offset) || Number(offset) !== upload.received)
      return context.json({ error: 'Upload offset mismatch or upload busy' }, 409)
    upload.busy = true
    try {
      const bytes = new Uint8Array(await context.req.arrayBuffer())
      if (bytes.length === 0) return context.json({ error: 'Empty chunk' }, 400)
      if (bytes.length > PROMPT_ATTACHMENT_CHUNK_BYTES || upload.received + bytes.length > upload.size)
        return context.json({ error: 'Chunk exceeds declared size' }, 413)
      await appendFile(upload.partial, bytes)
      upload.received += bytes.length
      upload.expiresAt = Date.now() + IDLE_EXPIRY_MS
      return context.json({ received: upload.received })
    } catch (error) {
      uploads.delete(context.req.param('id'))
      await rm(upload.directory, { recursive: true, force: true })
      throw error
    } finally {
      upload.busy = false
    }
  })

  app.post('/:id/complete', async (context) => {
    const id = context.req.param('id')
    const upload = uploads.get(id)
    if (!upload) return context.json({ error: 'Upload expired or not found' }, 404)
    if (upload.busy || upload.received !== upload.size) return context.json({ error: 'Upload incomplete or busy' }, 409)
    upload.busy = true
    try {
      await rename(upload.partial, upload.path)
      uploads.delete(id)
      await writePromptAttachmentMetadata(upload.directory, {
        filename: upload.filename,
        size: upload.size,
        uploadedAt: Date.now(),
        directory: upload.sessionDirectory,
        sessionID: upload.sessionID,
      })
      return context.json({ path: upload.path, size: upload.size })
    } finally {
      upload.busy = false
    }
  })

  app.delete('/:id', async (context) => {
    const id = context.req.param('id')
    const upload = uploads.get(id)
    if (!upload) return context.body(null, 204)
    if (upload.busy) return context.json({ error: 'Upload busy' }, 409)
    upload.busy = true
    try {
      await rm(upload.directory, { recursive: true, force: true })
      uploads.delete(id)
      return context.body(null, 204)
    } finally {
      upload.busy = false
    }
  })
  return app
}
