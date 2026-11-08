import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { StoredPromptAttachmentListSchema } from '@opencode-manager/shared/schemas'
import { createPromptAttachmentRoutes } from './prompt-attachments'

const environment = vi.hoisted(() => ({ workspace: '' }))
vi.mock('@opencode-manager/shared/config/env', () => ({
  getWorkspacePath: () => environment.workspace,
  getReposPath: () => join(environment.workspace, 'repos'),
}))
const uploadedSchema = z.object({ path: z.string(), size: z.number() })

describe('stored prompt attachment library', () => {
  beforeEach(async () => {
    environment.workspace = await mkdtemp(join(tmpdir(), 'prompt-library-'))
  })
  afterEach(async () => {
    await rm(environment.workspace, { recursive: true, force: true })
  })

  const storage = () => join(environment.workspace, 'repos', '.attachments')

  async function upload(app: ReturnType<typeof createPromptAttachmentRoutes>, file: File, sessionID?: string) {
    const body = new FormData()
    body.set('file', file)
    body.set('directory', '/workspace/repos/assistant')
    if (sessionID !== undefined) body.set('sessionID', sessionID)
    return app.request('/', { method: 'POST', body })
  }

  async function list(app: ReturnType<typeof createPromptAttachmentRoutes>) {
    const response = await app.request('/')
    expect(response.status).toBe(200)
    return StoredPromptAttachmentListSchema.parse(await response.json())
  }

  it('lists uploads newest first with original name, size, session and directory', async () => {
    const app = createPromptAttachmentRoutes()
    const first = uploadedSchema.parse(
      await (await upload(app, new File(['first'], '보고서 1.pdf'), 'ses_firstSession')).json(),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = uploadedSchema.parse(
      await (await upload(app, new File(['second!'], 'clip.mp4'), 'ses_second')).json(),
    )

    const result = await list(app)

    expect(result.entries.map((entry) => entry.path)).toEqual([second.path, first.path])
    expect(result.entries[1]).toMatchObject({
      filename: '보고서 1.pdf',
      storedName: 'original.pdf',
      size: 5,
      directory: '/workspace/repos/assistant',
      sessionID: 'ses_firstSession',
      hasMetadata: true,
    })
    expect(result.totalBytes).toBe(12)
    expect((await stat(join(dirname(first.path), 'meta.json'))).mode & 0o777).toBe(0o600)
  })

  it('records the session of chunked uploads when they complete', async () => {
    const app = createPromptAttachmentRoutes()
    const started = await app.request('/chunks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'archive.zip', directory: '/repo', size: 2, sessionID: 'ses_chunked' }),
    })
    const { uploadId } = z.object({ uploadId: z.string() }).parse(await started.json())
    expect((await list(app)).entries).toEqual([])
    await app.request(`/chunks/${uploadId}?offset=0`, { method: 'PUT', body: new Uint8Array([80, 75]) })
    expect((await app.request(`/chunks/${uploadId}/complete`, { method: 'POST' })).status).toBe(200)

    expect((await list(app)).entries).toEqual([
      expect.objectContaining({ filename: 'archive.zip', sessionID: 'ses_chunked', directory: '/repo', size: 2 }),
    ])
  })

  it('shows uploads stored before metadata existed under their stored name and file time', async () => {
    const legacy = join(storage(), 'file-Ab12Cd')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'original.hwp'), 'legacy')
    await utimes(join(legacy, 'original.hwp'), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    await writeFile(join(storage(), 'not-an-upload.txt'), 'x')
    await mkdir(join(storage(), 'file-Zz99Yy'))
    await writeFile(join(storage(), 'file-Zz99Yy', 'upload.part'), 'partial')

    const result = await list(createPromptAttachmentRoutes())

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: 'file-Ab12Cd',
        filename: 'original.hwp',
        directory: null,
        sessionID: null,
        hasMetadata: false,
        size: 6,
      }),
    ])
  })

  it('ignores invalid metadata instead of trusting it', async () => {
    const app = createPromptAttachmentRoutes()
    const uploaded = uploadedSchema.parse(await (await upload(app, new File(['x'], 'a.txt'))).json())
    await rm(join(dirname(uploaded.path), 'meta.json'))
    await writeFile(join(dirname(uploaded.path), 'meta.json'), '{"filename":"../../etc/passwd"}')

    expect((await list(app)).entries[0]).toMatchObject({ filename: 'original.txt', hasMetadata: false })
  })

  it('rejects an invalid session id without storing the file', async () => {
    const response = await upload(createPromptAttachmentRoutes(), new File(['x'], 'a.txt'), '../ses')
    expect(response.status).toBe(400)
    expect(await readdir(environment.workspace)).toEqual([])
  })

  it('opens safe types inline in a sandbox and downloads them on request with the original name', async () => {
    const app = createPromptAttachmentRoutes()
    await upload(app, new File([new Uint8Array([137, 80, 78, 71])], '스크린샷 "1".png'), 'ses_image')
    const [entry] = (await list(app)).entries

    const inline = await app.request(`/${entry!.id}/content`)
    expect(inline.status).toBe(200)
    expect(Buffer.from(await inline.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(inline.headers.get('content-type')).toBe('image/png')
    expect(inline.headers.get('content-disposition')).toBe(
      `inline; filename="____ _1_.png"; filename*=UTF-8''${encodeURIComponent('스크린샷 "1".png')}`,
    )
    expect(inline.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff')

    const download = await app.request(`/${entry!.id}/content?download=1`)
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
    expect(download.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true)
  })

  it.each(['page.html', 'image.svg', 'script.js', 'archive.zip'])('never renders %s inline', async (filename) => {
    const app = createPromptAttachmentRoutes()
    await upload(app, new File(['<script>alert(1)</script>'], filename))
    const [entry] = (await list(app)).entries

    const response = await app.request(`/${entry!.id}/content`)

    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true)
  })

  it('deletes only the selected upload', async () => {
    const app = createPromptAttachmentRoutes()
    const kept = uploadedSchema.parse(await (await upload(app, new File(['keep'], 'keep.txt'))).json())
    const removed = uploadedSchema.parse(await (await upload(app, new File(['drop'], 'drop.txt'))).json())
    const id = dirname(removed.path).split('/').at(-1)!

    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(204)

    expect((await list(app)).entries.map((entry) => entry.path)).toEqual([kept.path])
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.request(`/${id}/content`)).status).toBe(404)
  })

  it.each(['..', 'file-..%2F..', 'chunks', 'file-abc', 'other-Ab12Cd'])('refuses unknown id %s', async (id) => {
    const app = createPromptAttachmentRoutes()
    await upload(app, new File(['keep'], 'keep.txt'))

    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.request(`/${id}/content`)).status).toBe(404)
    expect((await list(app)).entries).toHaveLength(1)
  })

  it('does not follow a symlinked upload directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'prompt-library-outside-'))
    try {
      await writeFile(join(outside, 'original.txt'), 'outside')
      await mkdir(storage(), { recursive: true })
      await symlink(outside, join(storage(), 'file-Ln1Kab'))
      const app = createPromptAttachmentRoutes()

      expect((await list(app)).entries).toEqual([])
      expect((await app.request('/file-Ln1Kab', { method: 'DELETE' })).status).toBe(404)
      expect((await app.request('/file-Ln1Kab/content')).status).toBe(404)
      expect(await readdir(outside)).toEqual(['original.txt'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('returns an empty list before anything was uploaded', async () => {
    expect(await list(createPromptAttachmentRoutes())).toEqual({ entries: [], totalBytes: 0 })
  })
})
