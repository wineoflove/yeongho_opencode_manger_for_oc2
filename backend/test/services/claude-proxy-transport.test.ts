import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeProxyGate } from '../../src/services/claude-proxy-gate'
import { ClaudeProxyTransport } from '../../src/services/claude-proxy-transport'

async function fixture(
  handler: RequestListener,
  timeouts: { headersTimeoutMs?: number; streamIdleTimeoutMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-transport-'))
  const path = join(root, 'gate')
  const gate = await ClaudeProxyGate.initialize(path)
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_listener_missing')
  const settings = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'fixture-private-client-key',
    ...timeouts,
  }
  return {
    client: new ClaudeProxyTransport(gate, settings),
    restart: () => new ClaudeProxyTransport(new ClaudeProxyGate(path), settings),
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await rm(root, { recursive: true })
    },
  }
}

describe('Claude proxy inference transport', () => {
  it('blocks a JSON permission error even when HTTP status is 200', async () => {
    const source = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'permission_error', message: 'private-json-detail' },
        }),
      )
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('private-json-detail')
      await expect(source.restart().messages('{}', AbortSignal.timeout(2000))).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
    } finally {
      await source.close()
    }
  })

  it('ends on a generic SSE error without waiting for the upstream connection to close', async () => {
    const source = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"type":"error","error":{"type":"overloaded_error","message":"private"}}\n\n')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(await response.text()).toBe(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Upstream stream failed."}}\n\n',
      )
    } finally {
      await source.close()
    }
  })

  it('preserves only valid cooldown headers on quota errors', async () => {
    const source = await fixture((_request, response) => {
      response.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-reset': '1794469000',
        'anthropic-ratelimit-unified-status': 'rejected',
        'x-secret': 'private',
      })
      response.end('private-body')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(response.headers.get('retry-after')).toBe('60')
      expect(response.headers.get('anthropic-ratelimit-unified-5h-reset')).toBe('1794469000')
      expect(response.headers.get('anthropic-ratelimit-unified-status')).toBe('rejected')
      expect(response.headers.get('x-secret')).toBeNull()
      expect(await response.text()).not.toContain('private-body')
    } finally {
      await source.close()
    }
  })
  it.each([false, true])('persists in-band denial with invalid trailing UTF-8=%s', async (invalidBytes) => {
    let calls = 0
    const source = await fixture((_request, response) => {
      calls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = Buffer.from(
        'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"private-error-body"}}\n\n',
      )
      response.end(invalidBytes ? Buffer.concat([frame, Buffer.from([255])]) : frame)
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      const body = await response.text()
      expect(body).toContain('"type":"permission_error"')
      expect(body).not.toContain('private-error-body')
      await expect(source.restart().messages('{}', AbortSignal.timeout(2000))).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
      expect(calls).toBe(1)
    } finally {
      await source.close()
    }
  })
  it('relays successful streaming bytes without forwarding secret response headers', async () => {
    const source = await fixture((request, response) => {
      if (request.headers['x-api-key'] !== 'fixture-private-client-key') {
        response.writeHead(401).end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-private-token': 'private-value',
      })
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(await response.text()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      expect(response.headers.get('x-private-token')).toBeNull()
    } finally {
      await source.close()
    }
  })

  it('blocks subsequent requests after 403, including a recreated transport', async () => {
    let calls = 0
    const source = await fixture((_request, response) => {
      calls++
      response.writeHead(403).end('private-upstream-error')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('private-upstream-error')
      await expect(source.client.messages('{}', AbortSignal.timeout(2000))).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
      await expect(source.restart().messages('{}', AbortSignal.timeout(2000))).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
      expect(calls).toBe(1)
    } finally {
      await source.close()
    }
  })

  it('aborts an already streaming request when a concurrent request is denied', async () => {
    let calls = 0
    const source = await fixture((_request, response) => {
      calls++
      if (calls === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"type":"ping"}\n\n')
      } else response.writeHead(403).end()
    })
    try {
      const first = await source.client.messages('{}', AbortSignal.timeout(3000))
      const reader = first.body?.getReader()
      expect(reader).toBeDefined()
      expect((await reader?.read())?.done).toBe(false)
      const pending = reader?.read()
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      })
      const second = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(second.status).toBe(403)
      await rejected
      expect(calls).toBe(2)
    } finally {
      await source.close()
    }
  })

  it('keeps relaying a stream that outlives both timeouts while bytes keep arriving', async () => {
    const source = await fixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        let sent = 0
        const timer = setInterval(() => {
          sent++
          if (sent < 20) response.write('event: ping\ndata: {"type":"ping"}\n\n')
          else {
            clearInterval(timer)
            response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          }
        }, 50)
        response.on('close', () => clearInterval(timer))
      },
      { headersTimeoutMs: 300, streamIdleTimeoutMs: 300 },
    )
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(5000))
      const body = await response.text()
      expect(body.match(/"type":"ping"/g)).toHaveLength(19)
      expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true)
    } finally {
      await source.close()
    }
  })

  it('fails when upstream headers do not arrive within the headers timeout', async () => {
    const source = await fixture(() => {}, { headersTimeoutMs: 200, streamIdleTimeoutMs: 3000 })
    try {
      const started = performance.now()
      await expect(source.client.messages('{}', AbortSignal.timeout(4000))).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      })
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(150)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      await source.close()
    }
  })

  it('fails a stream that stays silent longer than the idle timeout', async () => {
    const source = await fixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: ping\ndata: {"type":"ping"}\n\n')
      },
      { headersTimeoutMs: 3000, streamIdleTimeoutMs: 200 },
    )
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(4000))
      const reader = response.body?.getReader()
      expect((await reader?.read())?.done).toBe(false)
      const started = performance.now()
      await expect(reader?.read()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      await source.close()
    }
  })

  it('returns a quota failure once without replaying to another credential', async () => {
    let calls = 0
    const source = await fixture((_request, response) => {
      calls++
      response.writeHead(429).end('private-error-body')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(2000))
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Upstream request failed.',
        },
      })
      expect(calls).toBe(1)
    } finally {
      await source.close()
    }
  })
})
