import { buildProxyResponseHeaders } from '../utils/proxy-headers'

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

export class MaintenanceIngressError extends Error {
  constructor() {
    super('INVALID_MAINTENANCE_TARGET')
    this.name = 'MaintenanceIngressError'
  }
}

function targetOrigin(value: string): URL {
  if (!URL.canParse(value)) throw new MaintenanceIngressError()
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.port ||
    Number(url.port) < 1024 ||
    ['5003', '5551'].includes(url.port)
  )
    throw new MaintenanceIngressError()
  return url
}

function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers(source)
  const connection =
    headers
      .get('connection')
      ?.split(',')
      .map((name) => name.trim()) ?? []
  for (const name of [...hopHeaders, ...connection]) if (name) headers.delete(name)
  headers.delete('host')
  return headers
}

export function createMaintenanceIngress(settings: { readonly backend: string; readonly terminal: string }) {
  const backend = targetOrigin(settings.backend)
  const terminal = targetOrigin(settings.terminal)
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('upgrade') || !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      return Response.json(
        {
          code: 'MAINTENANCE_DRAINING',
          error: 'Maintenance in progress. Try again later.',
        },
        {
          status: 503,
          headers: { 'cache-control': 'no-store', 'retry-after': '60' },
        },
      )
    const incoming = new URL(request.url)
    if (incoming.pathname === '/maintenance-health')
      return Response.json(
        {
          ingress: 'read-only',
          scope: 'frontend-http-only',
          schedulerFenced: false,
          nativeApiFenced: false,
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    const origin =
      incoming.pathname === '/api/terminal' || incoming.pathname.startsWith('/api/terminal/') ? terminal : backend
    const target = new URL(origin)
    target.pathname = incoming.pathname
    target.search = incoming.search
    try {
      const response = await fetch(target, {
        method: request.method,
        headers: forwardedHeaders(request.headers),
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
        { code: 'MAINTENANCE_UPSTREAM_UNAVAILABLE' },
        {
          status: 503,
          headers: { 'cache-control': 'no-store' },
        },
      )
    }
  }
}
