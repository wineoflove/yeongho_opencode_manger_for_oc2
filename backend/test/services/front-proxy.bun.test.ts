import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { createFrontProxy, frontProxyServeOptions, type FrontProxySocket } from '../../src/services/front-proxy'

type UpstreamSocket = { cookie: string | null; forwardedHost: string | null }

let upstream: Server<UpstreamSocket>
let proxy: Server<FrontProxySocket>
const seenSockets: UpstreamSocket[] = []
const forwarded = { host: 'manager.example.test', proto: 'https' } as const

function eventStream(first: string, gapMs: number, second: string): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(first))
        await Bun.sleep(gapMs)
        controller.enqueue(encoder.encode(second))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

beforeAll(() => {
  upstream = Bun.serve<UpstreamSocket>({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/api/socket') {
        return server.upgrade(request, {
          data: {
            cookie: request.headers.get('cookie'),
            forwardedHost: request.headers.get('x-forwarded-host'),
          },
        })
          ? undefined
          : new Response('no upgrade', { status: 400 })
      }
      if (url.pathname === '/api/hang') {
        await Bun.sleep(5000)
        return new Response('late', { status: 504 })
      }
      if (url.pathname === '/api/redirect')
        return new Response(null, {
          status: 302,
          headers: { location: '/elsewhere' },
        })
      if (url.pathname === '/api/stream') return eventStream('data: first\n\n', 300, 'data: second\n\n')
      if (url.pathname === '/api/slow-stream') return eventStream('data: before\n\n', 12000, 'data: after\n\n')
      return Response.json({
        method: request.method,
        path: url.pathname + url.search,
        body: request.method === 'GET' ? null : await request.text(),
        origin: request.headers.get('origin'),
        cookie: request.headers.get('cookie'),
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProto: request.headers.get('x-forwarded-proto'),
        forwardedFor: request.headers.get('x-forwarded-for'),
        proxyAuthorization: request.headers.get('proxy-authorization'),
      })
    },
    websocket: {
      open(socket) {
        seenSockets.push(socket.data)
      },
      message(socket, message) {
        if (message === 'close-4001') socket.close(4001, 'requested')
        else socket.send(message)
      },
    },
  })
  const handler = createFrontProxy({
    backend: `http://127.0.0.1:${upstream.port}`,
    forwarded,
    bufferedBytes: 64 * 1024,
    connectTimeoutMs: 300,
  })
  proxy = Bun.serve<FrontProxySocket>({
    ...frontProxyServeOptions,
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler.fetch,
    websocket: handler.websocket,
  })
})

afterAll(async () => {
  await proxy.stop(true)
  await upstream.stop(true)
})

function openSocket(path: string, cookie?: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}${path}`, cookie ? { headers: { cookie } } : undefined)
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error('socket_error')), {
      once: true,
    })
  })
}

function closeEvent(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data), {
      once: true,
    }),
  )
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing_body')
  let text = ''
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    text += new TextDecoder().decode(chunk.value)
  return text
}

describe('front proxy', () => {
  test('forwards method, body, origin and cookies while replacing forwarding and hop headers', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/echo?x=1`, {
      method: 'POST',
      body: 'payload',
      headers: {
        origin: 'https://manager.example.test',
        cookie: 'session=abc',
        'proxy-authorization': 'Basic synthetic',
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'http',
        'x-forwarded-for': '203.0.113.9',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/api/echo?x=1',
      body: 'payload',
      origin: 'https://manager.example.test',
      cookie: 'session=abc',
      forwardedHost: 'manager.example.test',
      forwardedProto: 'https',
      forwardedFor: null,
      proxyAuthorization: null,
    })
  })

  test('returns upstream redirects without following them', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/redirect`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/elsewhere')
  })

  test('streams server-sent events incrementally', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/stream`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('missing_body')
    const started = Date.now()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
    expect(Date.now() - started).toBeLessThan(250)
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      rest += new TextDecoder().decode(chunk.value)
    expect(rest).toBe('data: second\n\n')
  })

  test('keeps a quiet event stream open longer than the default idle timeout', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/slow-stream`)
    expect(await readAll(response)).toBe('data: before\n\ndata: after\n\n')
  }, 20000)

  test('relays websocket text, binary frames, cookies, forwarding headers and close codes', async () => {
    const socket = await openSocket('/api/socket', 'session=ws')
    const text = nextMessage(socket)
    socket.send('hello')
    expect(await text).toBe('hello')
    const binary = nextMessage(socket)
    socket.send(new Uint8Array([1, 2, 3]))
    expect([...new Uint8Array((await binary) as ArrayBuffer)]).toEqual([1, 2, 3])
    expect(seenSockets).toContainEqual({
      cookie: 'session=ws',
      forwardedHost: 'manager.example.test',
    })
    const closed = closeEvent(socket)
    socket.send('close-4001')
    const event = await closed
    expect(event.code).toBe(4001)
    expect(event.reason).toBe('requested')
  })

  test('closes a websocket whose upstream handshake never completes', async () => {
    const socket = await openSocket('/api/hang')
    expect((await closeEvent(socket)).code).toBe(1011)
  })

  test('closes a websocket when frames queued before the upstream opens exceed the byte limit', async () => {
    const socket = await openSocket('/api/hang')
    const closed = closeEvent(socket)
    socket.send(new Uint8Array(40 * 1024))
    socket.send(new Uint8Array(40 * 1024))
    expect((await closed).code).toBe(1013)
  })

  test('rejects websocket subprotocols it cannot negotiate', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/socket`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'chat',
      },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('FRONT_PROXY_SUBPROTOCOL_UNSUPPORTED')
  })

  test('reports an unavailable upstream for http and websocket traffic', async () => {
    const closedUpstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('x'),
    })
    const port = closedUpstream.port
    await closedUpstream.stop(true)
    const handler = createFrontProxy({
      backend: `http://127.0.0.1:${port}`,
      forwarded,
    })
    const isolated = Bun.serve<FrontProxySocket>({
      ...frontProxyServeOptions,
      hostname: '127.0.0.1',
      port: 0,
      fetch: handler.fetch,
      websocket: handler.websocket,
    })
    try {
      const response = await fetch(`http://127.0.0.1:${isolated.port}/api/health`)
      expect(response.status).toBe(502)
      expect(((await response.json()) as { code: string }).code).toBe('FRONT_PROXY_UPSTREAM_UNAVAILABLE')
      const socket = new WebSocket(`ws://127.0.0.1:${isolated.port}/api/socket`)
      expect((await closeEvent(socket)).code).toBe(1011)
    } finally {
      await isolated.stop(true)
    }
  })

  test('refuses non-loopback or reserved targets and invalid settings', () => {
    for (const backend of ['http://0.0.0.0:5101', 'http://127.0.0.1:5003', 'https://127.0.0.1:5101'])
      expect(() => createFrontProxy({ backend, forwarded })).toThrow('INVALID_LOOPBACK_PROXY_TARGET')
    const backend = 'http://127.0.0.1:5101'
    expect(() =>
      createFrontProxy({
        backend,
        forwarded: { host: 'bad host/x', proto: 'https' },
      }),
    ).toThrow('INVALID_FRONT_PROXY_SETTINGS')
    expect(() => createFrontProxy({ backend, forwarded, bufferedBytes: 10 })).toThrow('INVALID_FRONT_PROXY_SETTINGS')
  })
})
