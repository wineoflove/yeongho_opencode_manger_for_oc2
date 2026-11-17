import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMaintenanceIngress } from '../../src/services/maintenance-ingress'

const gateway = createMaintenanceIngress({
  backend: 'http://127.0.0.1:5101',
  terminal: 'http://127.0.0.1:5104',
})
afterEach(() => vi.restoreAllMocks())

describe('temporary read-only frontend ingress', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'])('blocks %s before forwarding', async (method) => {
    const upstream = vi.spyOn(globalThis, 'fetch')
    const response = await gateway(new Request('http://localhost/api/session', { method }))
    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('blocks a websocket upgrade before forwarding', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch')
    const response = await gateway(
      new Request('http://localhost/api/terminal/socket', {
        headers: { upgrade: 'websocket' },
      }),
    )
    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
  it.each([
    ['/api/session?directory=%2Ffixture', 'http://127.0.0.1:5101/api/session?directory=%2Ffixture'],
    ['/api/terminal/status', 'http://127.0.0.1:5104/api/terminal/status'],
    ['//external.invalid/path', 'http://127.0.0.1:5101//external.invalid/path'],
  ])('keeps read requests on the configured upstream: %s', async (path, target) => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: ready\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          connection: 'x-private',
          'x-private': 'removed',
        },
      }),
    )
    const response = await gateway(
      new Request('http://localhost' + path, {
        headers: {
          cookie: 'synthetic-cookie',
          connection: 'x-private',
          'x-private': 'removed',
        },
      }),
    )
    expect(await response.text()).toBe('data: ready\n\n')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-private')).toBeNull()
    const call = upstream.mock.calls[0]
    expect(String(call?.[0])).toBe(target)
    expect(new Headers(call?.[1]?.headers).get('cookie')).toBe('synthetic-cookie')
    expect(new Headers(call?.[1]?.headers).get('x-private')).toBeNull()
    expect(call?.[1]?.redirect).toBe('manual')
  })
  it('reports only the ingress boundary rather than full maintenance readiness', async () => {
    const response = await gateway(new Request('http://localhost/maintenance-health'))
    expect(await response.json()).toEqual({
      ingress: 'read-only',
      scope: 'frontend-http-only',
      schedulerFenced: false,
      nativeApiFenced: false,
    })
  })
  it('does not expose upstream failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private detail'))
    const response = await gateway(new Request('http://localhost/api/health'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'MAINTENANCE_UPSTREAM_UNAVAILABLE',
    })
  })
  it('removes encoded length metadata after fetch has decoded an upstream body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('decoded', {
        headers: { 'content-encoding': 'gzip', 'content-length': '80' },
      }),
    )
    const response = await gateway(new Request('http://localhost/api/fixture'))
    expect(await response.text()).toBe('decoded')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
  })
})
