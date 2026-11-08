import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadPromptFile } from './promptAttachments'

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
