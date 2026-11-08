import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  classifyAttachment,
  readPromptAttachment,
  ATTACHMENT_ACCEPT,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
} from './promptAttachments'
import { uploadPromptFile } from '../api/promptAttachments'

vi.mock('../api/promptAttachments', async (original) => ({
  ...(await original<typeof import('../api/promptAttachments')>()),
  uploadPromptFile: vi.fn(),
}))

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../api/promptAttachments')>('../api/promptAttachments')
  vi.mocked(uploadPromptFile).mockReset().mockImplementation(actual.uploadPromptFile)
})

afterEach(() => vi.unstubAllGlobals())

const decodeBase64Utf8 = (base64: string): string => {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

describe('classifyAttachment', () => {
  it('classifies images by mime', () => {
    expect(classifyAttachment({ name: 'photo.png', type: 'image/png' })).toBe('image')
    expect(classifyAttachment({ name: 'photo.HEIC', type: 'image/heic' })).toBe('image')
  })

  it('classifies pdf by mime', () => {
    expect(classifyAttachment({ name: 'doc.pdf', type: 'application/pdf' })).toBe('pdf')
  })

  it('classifies code files by extension even when browser mime is wrong or empty', () => {
    expect(classifyAttachment({ name: 'App.ts', type: 'video/mp2t' })).toBe('text')
    expect(classifyAttachment({ name: 'notes.md', type: '' })).toBe('text')
    expect(classifyAttachment({ name: 'Dockerfile', type: '' })).toBe('text')
    expect(classifyAttachment({ name: 'icon.svg', type: 'image/svg+xml' })).toBe('text')
  })

  it('classifies unknown extensions with text mime as text', () => {
    expect(classifyAttachment({ name: 'data.custom', type: 'text/x-custom' })).toBe('text')
    expect(classifyAttachment({ name: 'data.foo', type: 'application/json' })).toBe('text')
  })

  it('accepts arbitrary binaries and extensionless files', () => {
    expect(classifyAttachment({ name: 'clip.mp4', type: 'video/mp4' })).toBe('file')
    expect(classifyAttachment({ name: 'blob', type: '' })).toBe('file')
  })

  it('recognizes ZIP extensions regardless of browser MIME', () => {
    for (const type of ['', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream']) {
      expect(classifyAttachment({ name: 'archive.ZIP', type })).toBe('file')
    }
  })
})

describe('ATTACHMENT_ACCEPT', () => {
  it('does not filter file selection by extension', () => {
    expect(ATTACHMENT_ACCEPT).toBeUndefined()
  })
})

describe('readPromptAttachment', () => {
  it.each(['report.xlsx', 'document.hwp', 'plugin.wasm', 'clip.mp4', 'custom.xyz', 'LICENSE.custom', 'no-extension'])(
    'uploads %s without treating binary bytes as text',
    async (filename) => {
      const file = new File([new Uint8Array([0, 255, 128, 1])], filename)
      const path = '/workspace/repos/.attachments/file-123/original.bin'
      const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path, size: file.size })))
      vi.stubGlobal('fetch', request)
      const result = await readPromptAttachment(file, '/repo')
      expect(result.ok).toBe(true)
      expect(request).toHaveBeenCalledTimes(1)
      if (!result.ok) throw new Error(result.reason)
      expect(result.attachment.filename).toBe(filename)
      expect(decodeBase64Utf8(result.attachment.dataUrl.split(',')[1])).toContain(path)
    },
  )
  it.each(['/home/wineoflove/apps/opencode-manager', '/workspace/repos/assistant'])(
    'uploads a ZIP from %s with the central persisted path',
    async (directory) => {
      const file = new File([new Uint8Array([80, 75, 3, 4, 0, 255])], '자료.zip', {
        type: 'application/x-zip-compressed',
      })
      const archivePath = '/workspace/repos/.attachments/zip-123/original.zip'
      const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: archivePath, size: file.size })))
      vi.stubGlobal('fetch', request)

      const result = await readPromptAttachment(file, directory)

      expect(request).toHaveBeenCalledWith(
        expect.stringContaining('/api/files/attachments'),
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      )
      const options = request.mock.calls[0]?.[1]
      expect(options.body.get('file')).toBe(file)
      expect(options.body.get('directory')).toBe(directory)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.attachment.mime).toBe('text/plain')
      expect(result.attachment.filename).toBe(file.name)
      const content = decodeBase64Utf8(result.attachment.dataUrl.split(',')[1])
      expect(content).toContain(archivePath)
      expect(content).toContain(file.name)
    },
  )

  it('returns an upload error without creating an attachment when the API rejects a ZIP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
    )
    const result = await readPromptAttachment(new File(['PK'], 'archive.zip'), '/workspace/repo')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('Unauthorized') })
  })

  it('does not upload oversized ZIPs', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const result = await readPromptAttachment(
      new File([new Uint8Array(MAX_BINARY_ATTACHMENT_BYTES + 1)], 'archive.zip'),
      '/workspace/repo',
    )
    expect(result.ok).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('encodes text files as text/plain data urls preserving utf-8 content', async () => {
    const content = '# 제목\nconst x = 1\n'
    const file = new File([content], 'notes.md', { type: 'text/markdown' })

    const result = await readPromptAttachment(file)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachment.filename).toBe('notes.md')
    expect(result.attachment.mime).toBe('text/plain')
    expect(result.attachment.dataUrl.startsWith('data:text/plain;base64,')).toBe(true)
    expect(decodeBase64Utf8(result.attachment.dataUrl.split(',')[1])).toBe(content)
  })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])(
    'keeps original bytes for %s',
    async (type) => {
      const file = new File([new Uint8Array([137, 80, 78, 71])], 'pic', { type })

      const result = await readPromptAttachment(file)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.attachment.mime).toBe(type)
      expect(result.attachment.dataUrl).toBe(`data:${type};base64,iVBORw==`)
    },
  )

  it('requires a session directory for server-stored files', async () => {
    const file = new File(['x'], 'archive.zip', { type: 'application/zip' })

    const result = await readPromptAttachment(file)

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('session directory is required') })
  })

  it('rejects oversized text files', async () => {
    class OversizedFile extends File {
      get size() {
        return MAX_TEXT_ATTACHMENT_BYTES + 1
      }
    }
    const file = new OversizedFile([''], 'big.txt', { type: 'text/plain' })

    const result = await readPromptAttachment(file)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('too large')
    expect(result.reason).toContain('500MB')
  })

  it('allows binaries up to the binary limit but not beyond', async () => {
    const withinLimit = new File([new Uint8Array(1024)], 'a.png', { type: 'image/png' })
    const oversized = { name: 'b.png', type: 'image/png', size: MAX_BINARY_ATTACHMENT_BYTES + 1 } as File

    expect((await readPromptAttachment(withinLimit)).ok).toBe(true)
    expect((await readPromptAttachment(oversized)).ok).toBe(false)
  })

  it.each([
    ['large.txt', 'text/plain'],
    ['large.png', 'image/png'],
    ['large.pdf', 'application/pdf'],
    ['large.custom', 'application/octet-stream'],
  ])('uploads 500MB %s by reference rather than embedding it in the prompt', async (filename, type) => {
    class BoundaryFile extends File {
      get size() {
        return 500 * 1024 * 1024
      }
    }
    const file = new BoundaryFile([''], filename, { type })
    vi.mocked(uploadPromptFile).mockResolvedValue({ path: '/attachments/original', size: file.size })
    const result = await readPromptAttachment(file, '/repo')
    expect(result.ok).toBe(true)
    expect(uploadPromptFile).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error(result.reason)
    expect(result.attachment.dataUrl.length).toBeLessThan(2000)
    expect(result.attachment.mime).toBe('text/plain')
  })
})
