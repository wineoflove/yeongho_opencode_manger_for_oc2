import { createReadStream } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { PromptAttachmentSessionIdSchema } from '@opencode-manager/shared/schemas'
import {
  allocatePromptAttachment,
  deleteStoredPromptAttachment,
  findStoredPromptAttachment,
  listStoredPromptAttachments,
  writePromptAttachmentMetadata,
} from '../services/prompt-attachment-storage'
import { createPromptAttachmentChunkRoutes } from './prompt-attachment-chunks'

const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024
const directorySchema = z.string().min(1).refine(isAbsolute)
const INLINE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export function createPromptAttachmentRoutes() {
  const app = new Hono()
  app.route('/chunks', createPromptAttachmentChunkRoutes())
  app.get('/', async (context) => context.json(await listStoredPromptAttachments()))
  app.get('/:id/content', async (context) => {
    const entry = await findStoredPromptAttachment(context.req.param('id'))
    if (!entry) return context.json({ error: 'Attachment not found' }, 404)
    const inlineType = INLINE_TYPES[extname(entry.storedName)]
    const inline = inlineType !== undefined && context.req.query('download') !== '1'
    const stream = Readable.toWeb(createReadStream(entry.path)) as ReadableStream<Uint8Array>
    return new Response(stream, {
      headers: {
        'Content-Type': inline ? inlineType : 'application/octet-stream',
        'Content-Length': entry.size.toString(),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', entry.filename),
        'Content-Security-Policy': 'sandbox allow-scripts',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  })
  app.delete('/:id', async (context) => {
    if (!(await deleteStoredPromptAttachment(context.req.param('id'))))
      return context.json({ error: 'Attachment not found' }, 404)
    return context.body(null, 204)
  })
  app.post('/', bodyLimit({ maxSize: MAX_DIRECT_UPLOAD_BYTES + 64 * 1024 }), async (context) => {
    const body = await context.req.parseBody()
    const directory = directorySchema.safeParse(body.directory)
    const sessionID =
      body.sessionID === undefined ? undefined : PromptAttachmentSessionIdSchema.safeParse(body.sessionID)
    if (!(body.file instanceof File) || !directory.success || sessionID?.success === false) {
      return context.json({ error: 'A file and absolute session directory are required' }, 400)
    }
    const file = body.file
    if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
      return context.json({ error: 'Use chunked upload for files over 100MB (500MB maximum)' }, 413)
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    const allocation = await allocatePromptAttachment(file.name)
    if (!allocation) {
      return context.json({ error: 'Attachment storage must not be redirected' }, 403)
    }
    const { directory: uploadDirectory, path: archivePath } = allocation
    try {
      await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      await rm(uploadDirectory, { recursive: true, force: true })
      throw error
    }
    await writePromptAttachmentMetadata(uploadDirectory, {
      filename: file.name,
      size: file.size,
      uploadedAt: Date.now(),
      directory: directory.data,
      sessionID: sessionID?.data,
    })
    return context.json({ path: archivePath, size: file.size })
  })
  return app
}
