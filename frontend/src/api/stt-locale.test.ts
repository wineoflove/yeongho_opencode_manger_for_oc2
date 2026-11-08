import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale, type Locale } from '@/i18n/locale'
import { sttApi } from './stt'

describe('localized transcription errors', () => {
  let previous: Locale
  beforeEach(() => {
    previous = getLocale()
    setLocale('ko')
  })
  afterEach(() => {
    setLocale(previous)
    vi.restoreAllMocks()
  })
  it('keeps the canceled code when a DOMException abort is raised', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    await expect(sttApi.transcribe(new Blob(), 'fixture', controller.signal)).rejects.toMatchObject({
      message: '음성 변환이 취소되었습니다',
      code: 'CANCELED',
      statusCode: 499,
    })
  })
  it('localizes only the client fallback and preserves a server error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('invalid JSON', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Provider-specific message' }), {
          status: 400,
        }),
      )
    await expect(sttApi.transcribe(new Blob())).rejects.toMatchObject({
      message: '음성을 텍스트로 변환하지 못했습니다',
      statusCode: 502,
    })
    await expect(sttApi.transcribe(new Blob())).rejects.toMatchObject({
      message: 'Provider-specific message',
      statusCode: 400,
    })
  })
})
