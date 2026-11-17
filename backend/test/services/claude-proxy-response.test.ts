import { describe, expect, it } from 'vitest'
import { proxyErrorStatus, safeProxyError, safeProxyHeaders } from '../../src/services/claude-proxy-response'

describe('Claude response metadata contract', () => {
  it.each([
    ['permission_error', 403],
    ['authentication_error', 401],
    ['rate_limit_error', 429],
    ['overloaded_error', 529],
    ['unrecognized-private-error', 502],
  ])('maps %s to protocol status %i without returning unknown values', (type, status) => {
    const result = safeProxyError(type)
    expect(proxyErrorStatus(result.error.type)).toBe(status)
    expect(result.error.message).toBe('Upstream stream failed.')
    if (type === 'unrecognized-private-error') expect(result.error.type).toBe('api_error')
  })
  it('rejects malformed cooldown values and unknown headers', () => {
    const headers = safeProxyHeaders(
      new Headers({
        'retry-after': 'private-value',
        'request-id': 'Bearer private',
        'anthropic-ratelimit-unified-status': 'private-value',
        'anthropic-ratelimit-unified-5h-reset': 'NaN',
        'set-cookie': 'private-cookie',
      }),
    )
    expect([...headers]).toEqual([])
  })
})
