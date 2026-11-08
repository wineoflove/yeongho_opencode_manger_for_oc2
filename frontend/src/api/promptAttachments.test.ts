import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteStoredPromptAttachment, storedPromptAttachmentUrl, uploadPromptFile } from './promptAttachments'

const MB = 1024 * 1024
const id = 'a4834e55-6597-4a8f-8441-91e4dfc8de2e'
afterEach(() => vi.unstubAllGlobals())

describe('large attachment transport', () => {
  it('splits 500MB into requests of at most 8MB and finalizes once', async () => {
    class LargeFile extends File {
      get size() {
        return 500 * MB
      }
      slice(start = 0, end = this.size) {
        return new Blob([new Uint8Array(end - start)])
      }
    }
    const sizes: number[] = []
    let received = 0
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        if (!(init.body instanceof Blob)) throw new Error('Expected binary chunk')
        sizes.push(init.body.size)
        received += init.body.size
        return new Response(JSON.stringify({ received }))
      }
      return new Response(
        JSON.stringify(received ? { path: '/stored/original.bin', size: received } : { uploadId: id }),
      )
    })
    vi.stubGlobal('fetch', request)

    const result = await uploadPromptFile(new LargeFile([''], 'large.bin'), '/repo')

    expect(result.size).toBe(500 * MB)
    expect(sizes).toHaveLength(63)
    expect(Math.max(...sizes)).toBe(8 * MB)
    expect(request).toHaveBeenCalledTimes(65)
  })

  it('cancels partial uploads on failure without blindly retrying chunks', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadId: id })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Chunk failed' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)

    await expect(uploadPromptFile(new File([new Uint8Array(9 * MB)], 'large.bin'), '/repo')).rejects.toThrow(
      'Chunk failed',
    )

    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' })
  })
})

describe('stored attachment session tracking', () => {
  it.each([
    ['ses_abc123', 'ses_abc123'],
    ['draft-session', null],
    [undefined, null],
  ])('records session %s on direct uploads as %s', async (sessionID, expected) => {
    const request = vi.fn(async () => new Response(JSON.stringify({ path: '/stored/original.txt', size: 1 })))
    vi.stubGlobal('fetch', request)

    await uploadPromptFile(new File(['x'], 'a.txt'), '/repo', sessionID)

    const body = (request.mock.calls[0] as unknown as [string, RequestInit])[1].body
    if (!(body instanceof FormData)) throw new Error('Expected form data')
    expect(body.get('sessionID')).toBe(expected)
    expect(body.get('directory')).toBe('/repo')
  })

  it('records the session when a chunked upload starts', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadId: id })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stop' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)

    await expect(
      uploadPromptFile(new File([new Uint8Array(9 * MB)], 'large.bin'), '/repo', 'ses_chunked'),
    ).rejects.toThrow('stop')

    expect(JSON.parse(String((request.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      filename: 'large.bin',
      directory: '/repo',
      size: 9 * MB,
      sessionID: 'ses_chunked',
    })
  })

  it('builds content and delete URLs for a stored upload', async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)

    await deleteStoredPromptAttachment('file-Ab12Cd')

    expect(request.mock.calls[0]).toEqual([
      expect.stringMatching(/\/api\/files\/attachments\/file-Ab12Cd$/),
      expect.objectContaining({ method: 'DELETE' }),
    ])
    expect(storedPromptAttachmentUrl('file-Ab12Cd')).toMatch(/\/api\/files\/attachments\/file-Ab12Cd\/content$/)
    expect(storedPromptAttachmentUrl('file-Ab12Cd', { download: true })).toMatch(/\/content\?download=1$/)
  })
})
