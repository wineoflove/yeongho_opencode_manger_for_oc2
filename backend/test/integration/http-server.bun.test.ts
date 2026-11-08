import { afterAll, beforeAll, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { setImmediate } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { createHttpServer, type HttpServerHandle } from '../../src/utils/http-server'
import { resolveSocketIp } from '../../src/auth/client-ip'
import { isAllowedUpgradeOrigin, toWebSocketPeer } from '../../src/utils/websocket-bridge'
import { createPreviewGatewayApp, PreviewSessionStore } from '../../src/services/preview/gateway'

const app = new Hono()
const runtime = createHttpServer(app)
let server: HttpServerHandle
let gateway: HttpServerHandle
const store = new PreviewSessionStore()
const entered = Promise.withResolvers<void>()
const released = Promise.withResolvers<void>()
const completed = Promise.withResolvers<void>()
const buffered = Promise.withResolvers<number>()

test.each(['upload', 'preview'])(
  'preserves %s body policy above 128 MiB',
  async (scenario) => {
    const workspace = await mkdtemp(join(tmpdir(), 'ocm-body-limit-'))
    try {
      await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./http-body-fixture.ts', import.meta.url)), scenario],
        {
          env: {
            ...process.env,
            WORKSPACE_PATH: workspace,
            MAX_UPLOAD_SIZE_MB: '128',
          },
          timeout: 30000,
        },
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  },
  35000,
)

app.get(
  '/pressure',
  runtime.upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      const peer = toWebSocketPeer(ws)
      peer.send(new Uint8Array(8 * 1024 * 1024))
      buffered.resolve(peer.bufferedAmount())
      peer.close(1013, 'Client too slow')
    },
  })),
)

app.get('/ip', (c) => c.text(resolveSocketIp(c) ?? 'missing'))
app.post('/upload', async (c) => {
  const file = (await c.req.parseBody())['file']
  return c.text(file instanceof File ? String(file.size) : 'missing')
})
app.post('/stream', async (c) => {
  let size = 0
  for await (const chunk of c.req.raw.body ?? []) size += chunk.byteLength
  return c.text(String(size))
})
app.use('/socket', async (c, next) => {
  await setImmediate()
  if (c.req.query('disconnect')) {
    entered.resolve()
    await released.promise
  }
  if (c.req.header('authorization') !== 'Bearer test') return c.text('Unauthorized', 401)
  if (!isAllowedUpgradeOrigin(c.req.header('origin'), ['https://trusted.example'])) return c.text('Forbidden', 403)
  await next()
  if (c.req.query('disconnect')) completed.resolve()
})
app.get(
  '/:endpoint{socket|echo}',
  runtime.upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      const peer = toWebSocketPeer(ws)
      peer.send(`buffered:${peer.bufferedAmount()}`)
    },
    onMessage(event, ws) {
      if (typeof event.data === 'string' || event.data instanceof ArrayBuffer) ws.send(event.data)
    },
  })),
)

beforeAll(async () => {
  server = await runtime.start({ port: 0, hostname: '0.0.0.0' })
  gateway = await createPreviewGatewayApp(store).start({
    port: 0,
    hostname: '0.0.0.0',
  })
})
afterAll(async () => {
  await gateway.close()
  await server.close()
})

async function echo(port: number, path: string, headers: Record<string, string>): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
  socket.binaryType = 'arraybuffer'
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onerror = reject
      socket.onmessage = (event) => {
        try {
          if (typeof event.data === 'string') {
            expect(event.data).toBe('buffered:0')
            socket.send(new Uint8Array([99, 0, 255, 128, 1, 99]).subarray(1, 5))
          } else {
            expect(new Uint8Array(event.data)).toEqual(new Uint8Array([0, 255, 128, 1]))
            resolve()
          }
        } catch (error) {
          reject(error)
        }
      }
    })
  } finally {
    socket.close()
  }
}

test('delayed healthy upgrades preserve binary frame bytes', async () => {
  await echo(server.port, '/socket', {
    authorization: 'Bearer test',
    origin: 'https://trusted.example',
  })
})

test.each([
  ['', 'https://trusted.example', 401],
  ['Bearer test', 'https://evil.example', 403],
] as const)('rejects authorization %s and origin %s with %s', async (authorization, origin, status) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/socket`, {
    headers: {
      authorization,
      origin,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  })
  expect(response.status).toBe(status)
})

test('disconnect during delayed upgrade leaves new connections operational', async () => {
  const socket = connect(server.port, '127.0.0.1')
  socket.write(
    'GET /socket?disconnect=1 HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer test\r\n\r\n',
  )
  await entered.promise
  await new Promise<void>((resolve) => {
    socket.once('close', resolve)
    socket.destroy()
  })
  await setImmediate()
  released.resolve()
  await completed.promise
  await echo(server.port, '/socket', { authorization: 'Bearer test' })
})

test('socket IP ignores client supplied forwarding and internal headers', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/ip`, {
    headers: {
      'x-forwarded-for': '203.0.113.1',
      'x-ocm-auth-socket-ip': '203.0.113.2',
    },
  })
  expect(await response.text()).toBe('127.0.0.1')
})

test('native buffered amount exposes a slow peer above the 4 MiB bridge limit', async () => {
  const socket = connect(server.port, '127.0.0.1')
  socket.pause()
  try {
    socket.write(
      'GET /pressure HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    expect(await buffered.promise).toBeGreaterThan(4 * 1024 * 1024)
  } finally {
    socket.destroy()
  }
})

test('preview native listener enforces session authentication', async () => {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/socket`)
  expect(response.status).toBe(401)
  const token = store.issueStartToken({ port: server.port, host: '127.0.0.1' })
  const session = store.consumeStartToken(token)
  const proxied = await fetch(`http://127.0.0.1:${gateway.port}/ip`, {
    headers: { cookie: `ocm_preview=${session}` },
  })
  expect(await proxied.text()).toBe('127.0.0.1')
  await echo(gateway.port, '/echo', { cookie: `ocm_preview=${session}` })
})

const previousTransportCap = 128 * 1024 * 1024
const chunk = new Uint8Array(1024 * 1024)

function streamBody(prefix: string, chunks: number, suffix: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let sent = 0
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(prefix))
    },
    pull(controller) {
      if (sent < chunks) {
        sent += 1
        controller.enqueue(chunk)
        return
      }
      controller.enqueue(encoder.encode(suffix))
      controller.close()
    },
  })
}

test('multipart upload of a file at the previous transport cap is accepted', async () => {
  const boundary = 'ocm-boundary'
  const response = await fetch(`http://127.0.0.1:${server.port}/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: streamBody(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      previousTransportCap / chunk.byteLength,
      `\r\n--${boundary}--\r\n`,
    ),
  })
  expect(await response.text()).toBe(String(previousTransportCap))
}, 60_000)

test('preview gateway streams request bodies above the previous transport cap', async () => {
  const token = store.issueStartToken({ port: server.port, host: '127.0.0.1' })
  const session = store.consumeStartToken(token)
  const chunks = previousTransportCap / chunk.byteLength + 1
  const response = await fetch(`http://127.0.0.1:${gateway.port}/stream`, {
    method: 'POST',
    headers: { cookie: `ocm_preview=${session}` },
    body: streamBody('', chunks, ''),
  })
  expect(await response.text()).toBe(String(chunks * chunk.byteLength))
}, 60_000)

test('occupied listener rejects startup', async () => {
  await expect(
    createHttpServer(new Hono()).start({
      port: server.port,
      hostname: '0.0.0.0',
    }),
  ).rejects.toBeInstanceOf(Error)
})
