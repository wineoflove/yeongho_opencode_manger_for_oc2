import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePromptFileUploads } from './usePromptFileUploads'

afterEach(() => vi.unstubAllGlobals())

function delayedUpload() {
  let finish: (response: Response) => void = () => {
    throw new Error('Upload not started')
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  return () => finish(new Response(JSON.stringify({ path: '/workspace/.ocm-attachment-test/original.zip', size: 4 })))
}

describe('prompt upload lifecycle', () => {
  it('blocks sending synchronously until the attachment has been added', async () => {
    const finish = delayedUpload()
    const attached = vi.fn()
    const { result } = renderHook(() => usePromptFileUploads({ directory: '/workspace', sessionID: 'one' }, attached))
    let upload: Promise<void> | undefined
    act(() => {
      upload = result.current.addFileAttachments([new File(['PK'], 'a.zip')])
      expect(result.current.hasPendingUploads()).toBe(true)
    })
    expect(result.current.isUploading).toBe(true)
    expect(attached).not.toHaveBeenCalled()

    await act(async () => {
      finish()
      await upload
    })

    expect(attached).toHaveBeenCalledOnce()
    expect(result.current.hasPendingUploads()).toBe(false)
    expect(result.current.isUploading).toBe(false)
  })

  it('discards late results when the user switches sessions', async () => {
    const finish = delayedUpload()
    const attached = vi.fn()
    const { result, rerender } = renderHook(
      ({ sessionID }) => usePromptFileUploads({ directory: '/workspace', sessionID }, attached),
      { initialProps: { sessionID: 'one' } },
    )
    let upload: Promise<void> | undefined
    act(() => {
      upload = result.current.addFileAttachments([new File(['PK'], 'a.zip')])
    })
    rerender({ sessionID: 'two' })

    await act(async () => {
      finish()
      await upload
    })

    expect(attached).not.toHaveBeenCalled()
    expect(result.current.hasPendingUploads()).toBe(false)
  })
})
