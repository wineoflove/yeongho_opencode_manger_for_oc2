import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { allocatePromptAttachment } from '../services/prompt-attachment-storage'
import { createPromptAttachmentChunkRoutes } from './prompt-attachment-chunks'

const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024
const directorySchema = z.string().min(1).refine(isAbsolute)

export function createPromptAttachmentRoutes() {
  const app = new Hono()
  app.route('/chunks', createPromptAttachmentChunkRoutes())
  app.post('/', bodyLimit({ maxSize: MAX_DIRECT_UPLOAD_BYTES + 64 * 1024 }), async (context) => {
    const body = await context.req.parseBody()
    const directory = directorySchema.safeParse(body.directory)
    if (!(body.file instanceof File) || !directory.success) {
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
    return context.json({ path: archivePath, size: file.size })
  })
  return app
}
