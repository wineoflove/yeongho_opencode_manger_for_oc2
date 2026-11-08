import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale, type Locale } from '@/i18n/locale'
import { parseNetworkError } from '@/lib/opencode-errors'
import { FetchError, fetchWrapper } from './fetchWrapper'

function respondWith(body: string, status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  )
}

describe('fetchWrapper error bodies', () => {
  let original: Locale
  beforeEach(() => {
    original = getLocale()
    setLocale('en')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setLocale(original)
  })

  it('uses the JSON error message', async () => {
    respondWith(JSON.stringify({ error: 'Session not found', code: 'NOT_FOUND' }), 404)

    await expect(fetchWrapper('/api/x')).rejects.toMatchObject({
      message: 'Session not found',
      statusCode: 404,
      code: 'NOT_FOUND',
    })
  })

  it('localizes local fallback errors but preserves machine-readable failure codes', async () => {
    setLocale('ko')
    respondWith('<html>private gateway body</html>', 524)
    await expect(fetchWrapper('/api/x')).rejects.toMatchObject({
      message: '요청에 실패했습니다 (상태 코드: 524)',
      statusCode: 524,
    })
    respondWith('not JSON', 200)
    await expect(fetchWrapper('/api/x')).rejects.toMatchObject({
      message: 'JSON 응답이 올바르지 않습니다',
      code: 'INVALID_JSON',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    )
    const error = await fetchWrapper('/api/x').catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      message: '요청 시간이 초과되었습니다',
      statusCode: 408,
      code: 'TIMEOUT',
    })
    expect(parseNetworkError(error)).toMatchObject({
      title: '요청 시간이 초과되었습니다',
      isRetryable: true,
    })
  })

  it('keeps a plain-text error body', async () => {
    respondWith('upstream unavailable', 502)

    await expect(fetchWrapper('/api/x')).rejects.toMatchObject({
      message: 'upstream unavailable',
    })
  })

  it('replaces an HTML error page with a status message', async () => {
    respondWith('<!DOCTYPE html><html><body>A timeout occurred</body></html>', 524)

    const error = await fetchWrapper('/api/x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FetchError)
    expect((error as FetchError).message).toBe('Request failed with status 524')
  })
})
