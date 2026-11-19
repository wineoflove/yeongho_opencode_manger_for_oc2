import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProxyGate } from '../../src/services/claude-proxy-gate'
import { ClaudeProxyTransport } from '../../src/services/claude-proxy-transport'
import { maintenanceAdmission } from '../../src/services/maintenance-admission'
import type { Database } from 'bun:sqlite'
import type { OpenCodeClient } from '../../src/services/opencode/client'
import { getMaintenanceStatus } from '../../src/services/maintenance-status'

function idleNativeStatus() {
  const db = { query: () => ({ get: () => ({ count: 0 }), all: () => [] }) } as unknown as Database
  const client = { api: {
    session: { active: async () => ({}), list: async () => ({ data: [], cursor: {} }) },
    debug: { location: { list: async () => [] } }, pty: { list: async () => ({ data: [] }) },
  } } as unknown as OpenCodeClient
  return getMaintenanceStatus(db, client)
}

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
  afterEach(() => { expect(maintenanceAdmission.status().pendingHandlers).toBe(0) })
  it.each(['close', 'error', 'cancel'] as const)('retains admission through streamed %s, allows enter followups, then seal blocks upstream', async (ending) => {
    let calls = 0
    const upstreams: import('node:http').ServerResponse[] = []
    const source = await fixture((_request, response) => {
      calls++
      upstreams.push(response)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n')
    })
    try {
      const response = await source.client.messages('{}', AbortSignal.timeout(5000))
      maintenanceAdmission.enter('stream-owner')
      expect(maintenanceAdmission.status().pendingHandlers).toBe(1)
      expect((await idleNativeStatus()).drained).toBe(false)
      const followup = await source.client.messages('{}', AbortSignal.timeout(5000))
      expect(calls).toBe(2)
      expect(maintenanceAdmission.status().pendingHandlers).toBe(2)
      await followup.body!.cancel()
      expect(maintenanceAdmission.status().pendingHandlers).toBe(1)
      maintenanceAdmission.seal('stream-owner')
      expect((await idleNativeStatus()).drained).toBe(false)
      await expect(source.client.messages('{}', AbortSignal.timeout(5000))).rejects.toThrow('MAINTENANCE_DRAINING')
      expect(calls).toBe(2)
      if (ending === 'cancel') await response.body!.cancel()
      else {
        const consumption = response.text()
        if (ending === 'close') upstreams[0]!.end()
        else upstreams[0]!.destroy(new Error('stream failed'))
        if (ending === 'close') await consumption
        else await expect(consumption).rejects.toThrow()
      }
      await vi.waitFor(() => expect(maintenanceAdmission.status().pendingHandlers).toBe(0))
      expect((await idleNativeStatus()).drained).toBe(true)
    } finally {
      maintenanceAdmission.exit('stream-owner')
      await source.close()
    }
  })
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
