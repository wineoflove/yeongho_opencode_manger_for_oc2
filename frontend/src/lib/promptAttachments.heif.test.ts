import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPromptAttachment } from './promptAttachments'
import { usePromptFileUploads } from '../hooks/usePromptFileUploads'
import { setLocale } from '../i18n/locale'

const codec = vi.hoisted(() => vi.fn<() => Promise<ImageBitmap>>())
vi.mock('heic-to/csp', () => ({ heicTo: codec }))

const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217])
const close = vi.fn()
const bitmap = { width: 6000, height: 4000, close } satisfies ImageBitmap
const drawImage = vi.fn()
let output: Blob | null
let canvas: HTMLCanvasElement

beforeEach(() => {
  codec.mockReset().mockResolvedValue(bitmap)
  close.mockClear()
  drawImage.mockClear()
  output = new Blob([jpeg], { type: 'image/jpeg' })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = createElement(tag, options)
    if (element instanceof HTMLCanvasElement) {
      canvas = element
      Object.defineProperty(element, 'getContext', { value: () => ({ drawImage }) })
    }
    return element
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type, quality) {
    expect(type).toBe('image/jpeg')
    expect(quality).toBe(0.85)
    callback(output)
  })
})

afterEach(() => {
  setLocale('en')
  vi.restoreAllMocks()
})

describe('HEIF attachment conversion', () => {
  it.each([
    ['photo.HEIC', ''],
    ['photo.HeIf', 'application/octet-stream'],
    ['photo.heic', 'image/heic'],
    ['photo.heif', 'image/heif'],
    ['photo', 'image/heic-sequence'],
    ['photo', 'image/heif-sequence'],
  ])('sends JPEG bytes instead of the original %s (%s)', async (name, type) => {
    const file = new File(['original HEIF'], name, { type })
    const result = await readPromptAttachment(file)

    expect(codec).toHaveBeenCalledWith({ blob: file, type: 'bitmap' })
    expect(result).toMatchObject({
      ok: true,
      attachment: { filename: 'photo.jpg', mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/4AAC/9k=' },
    })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1365)
    expect(close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('rejects HEIF input above 20MB before decoding', async () => {
    class LargeFile extends File {
      get size() {
        return 20 * 1024 * 1024 + 1
      }
    }
    const result = await readPromptAttachment(new LargeFile(['x'], 'big.heic'), '/repo')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('20MB') })
    expect(codec).not.toHaveBeenCalled()
  })

  it('converts input at 20MB instead of uploading original HEIF by reference', async () => {
    class LimitFile extends File {
      get size() {
        return 20 * 1024 * 1024
      }
    }
    expect(await readPromptAttachment(new LimitFile(['x'], 'limit.heic'))).toMatchObject({
      ok: true,
      attachment: { mime: 'image/jpeg' },
    })
  })

  it('accepts JPEG output at 4MB without enlarging small images', async () => {
    const small = { width: 320, height: 640, close } satisfies ImageBitmap
    codec.mockResolvedValueOnce(small)
    output = new Blob([jpeg, new Uint8Array(4 * 1024 * 1024 - jpeg.length)], { type: 'image/jpeg' })
    const result = await readPromptAttachment(new File(['x'], 'small.heif'))
    expect(result.ok).toBe(true)
    expect(drawImage).toHaveBeenCalledWith(small, 0, 0, 320, 640)
  })

  it('releases the conversion queue after a decoder failure', async () => {
    codec.mockRejectedValueOnce(new Error('corrupt image'))
    const results = await Promise.all(
      ['bad.heic', 'good.heic'].map((name) => readPromptAttachment(new File(['x'], name))),
    )
    expect(results[0]).toMatchObject({ ok: false })
    expect(results[1]).toMatchObject({ ok: true, attachment: { filename: 'good.jpg' } })
  })

  it.each(['corrupt', 'wrong bytes', 'wrong mime', 'oversize output', 'empty output'])(
    'returns no attachment for %s',
    async (failure) => {
      setLocale('ko')
      if (failure === 'corrupt') codec.mockRejectedValueOnce(new Error('decoder failed'))
      if (failure === 'wrong bytes') output = new Blob(['HEIF'], { type: 'image/jpeg' })
      if (failure === 'wrong mime') output = new Blob([jpeg], { type: 'image/png' })
      if (failure === 'oversize output')
        output = new Blob([jpeg, new Uint8Array(4 * 1024 * 1024)], { type: 'image/jpeg' })
      if (failure === 'empty output') output = null
      expect(await readPromptAttachment(new File(['bad'], 'bad.heic', { type: 'image/heic' }))).toEqual({
        ok: false,
        reason: 'HEIF 이미지를 변환하지 못했습니다. JPEG 또는 PNG 이미지로 첨부해 주세요.',
      })
      if (failure !== 'corrupt') expect(close).toHaveBeenCalledOnce()
    },
  )

  it('serializes overlapping conversions and keeps uploads pending until JPEG is ready', async () => {
    let finish: (bitmap: ImageBitmap) => void = () => {
      throw new Error('Decoder not started')
    }
    let notifyStarted: () => void = () => {
      throw new Error('Start signal not initialized')
    }
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    codec.mockImplementationOnce(() => {
      notifyStarted()
      return new Promise<ImageBitmap>((resolve) => {
        finish = resolve
      })
    })
    const attached = vi.fn()
    const { result } = renderHook(() => usePromptFileUploads({ sessionID: 'one' }, attached))
    let uploads: Promise<void>[] = []
    act(() => {
      uploads = ['a.heic', 'b.heif'].map((name) => result.current.addFileAttachments([new File(['x'], name)]))
    })
    await started
    expect(codec).toHaveBeenCalledOnce()
    expect(result.current.hasPendingUploads()).toBe(true)
    expect(result.current.isUploading).toBe(true)
    expect(attached).not.toHaveBeenCalled()
    await act(async () => {
      finish(bitmap)
      await Promise.all(uploads)
    })
    expect(attached).toHaveBeenCalledTimes(2)
    expect(attached).toHaveBeenLastCalledWith(expect.objectContaining({ filename: 'b.jpg', mime: 'image/jpeg' }))
    expect(result.current.hasPendingUploads()).toBe(false)
  })
})
