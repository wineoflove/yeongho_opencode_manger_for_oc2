import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { buildProxyResponseHeaders } from '../utils/proxy-headers'
import { forwardedHeaders, loopbackTarget, proxiedUrl } from './loopback-proxy'

type Frame = string | Uint8Array

export type FrontProxySocket = {
  readonly target: string
  readonly headers: Record<string, string>
  upstream?: WebSocket
  readonly pending: Frame[]
  pendingBytes: number
  closed: boolean
  connectTimer?: ReturnType<typeof setTimeout>
}

export type FrontProxySettings = {
  readonly backend: string
  readonly forwarded: {
    readonly host: string
    readonly proto: 'http' | 'https'
  }
  readonly bufferedBytes?: number
  readonly connectTimeoutMs?: number
}

export class FrontProxySettingsError extends Error {
  constructor() {
    super('INVALID_FRONT_PROXY_SETTINGS')
    this.name = 'FrontProxySettingsError'
  }
}

const handshakeHeaders = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]

export const frontProxyServeOptions = {
  idleTimeout: 0,
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
} as const

function frameBytes(frame: Frame): number {
  return typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength
}

function closeCode(code: number): number {
  if (code === 1005) return 1000
  return code === 1006 || code === 1015 || code < 1000 || code > 4999 ? 1011 : code
}

export function createFrontProxy(settings: FrontProxySettings): {
  readonly fetch: (request: Request, server: Server<FrontProxySocket>) => Promise<Response | undefined>
  readonly websocket: WebSocketHandler<FrontProxySocket>
} {
  const backend = loopbackTarget(settings.backend)
  const bufferedBytes = settings.bufferedBytes ?? 8 * 1024 * 1024
  const connectTimeoutMs = settings.connectTimeoutMs ?? 10000
  if (
    !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(settings.forwarded.host) ||
    !['http', 'https'].includes(settings.forwarded.proto) ||
    !Number.isSafeInteger(bufferedBytes) ||
    bufferedBytes < 64 * 1024 ||
    !Number.isSafeInteger(connectTimeoutMs) ||
    connectTimeoutMs < 100
  )
    throw new FrontProxySettingsError()
  const withForwarding = (source: Headers): Headers => {
    const headers = forwardedHeaders(source)
    for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-for'])
      headers.delete(name)
    headers.set('x-forwarded-host', settings.forwarded.host)
    headers.set('x-forwarded-proto', settings.forwarded.proto)
    return headers
  }
  const fail = (client: ServerWebSocket<FrontProxySocket>, code: number, reason: string) => {
    if (client.data.closed) return
    client.data.closed = true
    clearTimeout(client.data.connectTimer)
    client.close(code, reason)
    const upstream = client.data.upstream
    if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(1001)
  }
  return {
    fetch: async (request, server) => {
      const incoming = new URL(request.url)
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (request.headers.get('sec-websocket-protocol'))
          return Response.json({ code: 'FRONT_PROXY_SUBPROTOCOL_UNSUPPORTED' }, { status: 400 })
        const headers = withForwarding(request.headers)
        for (const name of handshakeHeaders) headers.delete(name)
        const upgraded = server.upgrade(request, {
          data: {
            target: proxiedUrl(backend, incoming, 'ws:').href,
            headers: Object.fromEntries(headers),
            pending: [],
            pendingBytes: 0,
            closed: false,
          },
        })
        return upgraded ? undefined : Response.json({ code: 'FRONT_PROXY_UPGRADE_FAILED' }, { status: 400 })
      }
      try {
        const response = await fetch(proxiedUrl(backend, incoming, 'http:'), {
          method: request.method,
          headers: withForwarding(request.headers),
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          signal: request.signal,
          redirect: 'manual',
        })
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: buildProxyResponseHeaders(forwardedHeaders(response.headers)),
        })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        return Response.json(
          { code: 'FRONT_PROXY_UPSTREAM_UNAVAILABLE' },
          { status: 502, headers: { 'cache-control': 'no-store' } },
        )
      }
    },
    websocket: {
      backpressureLimit: bufferedBytes,
      closeOnBackpressureLimit: true,
      maxPayloadLength: bufferedBytes,
      open(client: ServerWebSocket<FrontProxySocket>) {
        const upstream = new WebSocket(client.data.target, {
          headers: client.data.headers,
        })
        upstream.binaryType = 'arraybuffer'
        client.data.upstream = upstream
        client.data.connectTimer = setTimeout(() => fail(client, 1011, 'upstream timeout'), connectTimeoutMs)
        upstream.addEventListener('open', () => {
          clearTimeout(client.data.connectTimer)
          for (const frame of client.data.pending.splice(0)) upstream.send(frame)
          client.data.pendingBytes = 0
        })
        upstream.addEventListener('message', (event) => {
          if (!client.data.closed) client.send(event.data as string | ArrayBuffer)
        })
        upstream.addEventListener('close', (event) => {
          if (client.data.closed) return
          client.data.closed = true
          clearTimeout(client.data.connectTimer)
          client.close(closeCode(event.code), event.reason)
        })
        upstream.addEventListener('error', () => fail(client, 1011, 'upstream unavailable'))
      },
      message(client: ServerWebSocket<FrontProxySocket>, message: string | Buffer) {
        const upstream = client.data.upstream
        const frame = typeof message === 'string' ? message : new Uint8Array(message)
        if (upstream?.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount + frameBytes(frame) > bufferedBytes) fail(client, 1013, 'upstream backpressure')
          else upstream.send(frame)
          return
        }
        if (client.data.pendingBytes + frameBytes(frame) > bufferedBytes) {
          fail(client, 1013, 'upstream not ready')
          return
        }
        client.data.pending.push(frame)
        client.data.pendingBytes += frameBytes(frame)
      },
      close(client: ServerWebSocket<FrontProxySocket>, code: number, reason: string) {
        client.data.closed = true
        clearTimeout(client.data.connectTimer)
        const upstream = client.data.upstream
        if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(closeCode(code), reason)
      },
    },
  }
}
