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

export class LoopbackProxyTargetError extends Error {
  constructor() {
    super('INVALID_LOOPBACK_PROXY_TARGET')
    this.name = 'LoopbackProxyTargetError'
  }
}

export function loopbackTarget(value: string): URL {
  if (!URL.canParse(value)) throw new LoopbackProxyTargetError()
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
    throw new LoopbackProxyTargetError()
  return url
}

export function forwardedHeaders(source: Headers): Headers {
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

export function proxiedUrl(base: URL, incoming: URL, protocol: 'http:' | 'ws:'): URL {
  const target = new URL(base)
  target.protocol = protocol
  target.pathname = incoming.pathname
  target.search = incoming.search
  return target
}
