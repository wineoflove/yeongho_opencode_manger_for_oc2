import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createPromptAttachmentRoutes } from './prompt-attachments'

const environment = vi.hoisted(() => ({ workspace: '' }))
const uploadSchema = z.object({ path: z.string() })
vi.mock('@opencode-manager/shared/config/env', () => ({
  getWorkspacePath: () => environment.workspace,
  getReposPath: () => join(environment.workspace, 'repos'),
}))

describe('prompt file uploads', () => {
  beforeEach(async () => {
    environment.workspace = await mkdtemp(join(tmpdir(), 'prompt-zip-'))
  })
  afterEach(async () => {
    await rm(environment.workspace, { recursive: true, force: true })
  })

  const upload = (file: File | string, directory = environment.workspace) => {
    const body = new FormData()
    body.set('file', file)
    body.set('directory', directory)
    return createPromptAttachmentRoutes().request('/', { method: 'POST', body })
  }

  it('preserves original binary bytes when a ZIP is uploaded', async () => {
    const bytes = Buffer.from(
      'UEsDBBQACAAIALpuMF0AAAAAAAAAAAAAAAAKAAAAYmluYXJ5LmJpbmP438DwjxEAUEsHCLEsx2sIAAAABgAAAFBLAwQUAAgACAC6bjBdAAAAAAAAAAAAAAAACQAAAG5vdGVzLnR4dIvyDFAIdFQoSa0oAQBQSwcIE1e1gg0AAAALAAAAUEsBAi0DFAAIAAgAum4wXbEsx2sIAAAABgAAAAoAAAAAAAAAAAAgAKSBAAAAAGJpbmFyeS5iaW5QSwECLQMUAAgACAC6bjBdE1e1gg0AAAALAAAACQAAAAAAAAAAACAApIFAAAAAbm90ZXMudHh0UEsFBgAAAAACAAIAbwAAAIQAAAAAAA==',
      'base64',
    )
    const response = await upload(new File([bytes], '../../binary.zip', { type: 'application/zip' }))
    expect(response.status).toBe(200)
    const result = uploadSchema.parse(await response.json())
    expect(await readFile(result.path)).toEqual(Buffer.from(bytes))
    expect(result.path).toMatch(/\/repos\/\.attachments\/zip-[^/]+\/original\.zip$/)
    expect(await readdir(environment.workspace)).toHaveLength(1)
  })

  it('uses different paths when filenames collide', async () => {
    const file = new File([new Uint8Array([80, 75, 5, 6])], 'same.zip')
    const first = uploadSchema.parse(await (await upload(file)).json())
    const second = uploadSchema.parse(await (await upload(file)).json())
    expect(first.path).not.toBe(second.path)
  })

  it('preserves uploads without requiring a ZIP signature', async () => {
    const response = await upload(new File(['not a zip'], 'fake.zip'))
    expect(response.status).toBe(200)
    expect(await readFile(uploadSchema.parse(await response.json()).path, 'utf8')).toBe('not a zip')
  })

  it.each([
    'report.xlsx',
    'document.hwp',
    'clip.mp4',
    'file.xyz',
    'no-extension',
    '../../escape.exe',
    'file.한글확장자',
    'file.verylongcustomextension',
  ])('stores arbitrary file %s without executing or extracting it', async (filename) => {
    const bytes = new Uint8Array([0, 255, 128, 1])
    const response = await upload(new File([bytes], filename))
    expect(response.status).toBe(200)
    const result = uploadSchema.parse(await response.json())
    expect(result.path.startsWith(`${join(environment.workspace, 'repos', '.attachments')}/`)).toBe(true)
    expect(await readFile(result.path)).toEqual(Buffer.from(bytes))
    expect((await stat(result.path)).mode & 0o111).toBe(0)
  })

  it('rejects string fields in place of files', async () => {
    expect((await upload('fake.zip')).status).toBe(400)
  })

  it('rejects a request exceeding the multipart body limit', async () => {
    const body = new FormData()
    body.set('file', new File(['small'], 'large.zip'))
    body.set('directory', environment.workspace)
    const response = await createPromptAttachmentRoutes().request('/', {
      method: 'POST',
      body,
      headers: { 'Content-Length': String(501 * 1024 * 1024) },
    })
    expect(response.status).toBe(413)
    expect(await readdir(environment.workspace)).toEqual([])
  })

  it('rejects oversized uploads before storing them', async () => {
    const response = await upload(new File([new Uint8Array(500 * 1024 * 1024 + 1)], 'large.zip'))
    expect(response.status).toBe(413)
  })

  it('accepts exactly 100MB and preserves every byte', async () => {
    const bytes = new Uint8Array(100 * 1024 * 1024)
    bytes[0] = 17
    bytes[bytes.length - 1] = 255
    const response = await upload(new File([bytes], 'large.custom'))
    expect(response.status).toBe(200)
    const saved = await readFile(uploadSchema.parse(await response.json()).path)
    expect(saved.length).toBe(bytes.length)
    expect(saved[0]).toBe(17)
    expect(saved[saved.length - 1]).toBe(255)
  })

  it.each(['/home/wineoflove/apps/opencode-manager', '/external/local-repo', '/workspace/repos/assistant'])(
    'stores ZIPs centrally for session directory %s',
    async (directory) => {
      const bytes = new Uint8Array([80, 75, 3, 4, 0, 255])
      const response = await upload(new File([bytes], 'a.zip'), directory)
      expect(response.status).toBe(200)
      const result = uploadSchema.parse(await response.json())
      expect(result.path.startsWith(`${join(environment.workspace, 'repos', '.attachments')}/`)).toBe(true)
      expect(await readFile(result.path)).toEqual(Buffer.from(bytes))
    },
  )

  it('ignores symlinked session directories as write destinations', async () => {
    const directory = join(environment.workspace, 'escape')
    await symlink(tmpdir(), directory)
    const response = await upload(new File([new Uint8Array([80, 75, 3, 4])], 'a.zip'), directory)
    expect(response.status).toBe(200)
    const result = uploadSchema.parse(await response.json())
    expect(result.path.startsWith(`${join(environment.workspace, 'repos', '.attachments')}/`)).toBe(true)
  })

  it('leaves a real external repository untouched when uploading through its workspace symlink', async () => {
    const externalRepository = await mkdtemp(join(tmpdir(), 'external-zip-repo-'))
    try {
      const link = join(environment.workspace, 'linked-repo')
      await symlink(externalRepository, link)
      const response = await upload(new File([new Uint8Array([80, 75, 3, 4])], 'a.zip'), link)
      expect(response.status).toBe(200)
      const result = uploadSchema.parse(await response.json())
      expect(await readFile(result.path)).toEqual(Buffer.from([80, 75, 3, 4]))
      expect(await readdir(externalRepository)).toEqual([])
    } finally {
      await rm(externalRepository, { recursive: true, force: true })
    }
  })

  it('rejects a redirected central attachment store', async () => {
    await mkdir(join(environment.workspace, 'repos'))
    await symlink(tmpdir(), join(environment.workspace, 'repos', '.attachments'))
    const response = await upload(new File([new Uint8Array([80, 75, 3, 4])], 'a.zip'))
    expect(response.status).toBe(403)
  })

  it('rejects a redirected repositories root', async () => {
    await symlink(tmpdir(), join(environment.workspace, 'repos'))
    const response = await upload(new File([new Uint8Array([80, 75, 3, 4])], 'a.zip'))
    expect(response.status).toBe(403)
  })
})
