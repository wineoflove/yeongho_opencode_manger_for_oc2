import { z } from 'zod'

export const proxyEnvelopeSchema = z.object({
  type: z.string(),
  error: z.object({ type: z.string() }).optional(),
})
const errorType = z.enum([
  'permission_error',
  'authentication_error',
  'rate_limit_error',
  'overloaded_error',
  'invalid_request_error',
  'not_found_error',
  'request_too_large',
  'api_error',
])

export function safeProxyError(value: unknown) {
  const type = errorType.safeParse(value)
  return {
    type: 'error',
    error: {
      type: type.success ? type.data : 'api_error',
      message: 'Upstream stream failed.',
    },
  }
}

export function proxyErrorStatus(type: ReturnType<typeof safeProxyError>['error']['type']): number {
  const statuses = {
    permission_error: 403,
    authentication_error: 401,
    rate_limit_error: 429,
    overloaded_error: 529,
    invalid_request_error: 400,
    not_found_error: 404,
    request_too_large: 413,
    api_error: 502,
  }
  return statuses[type]
}

export function safeProxyHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of source) {
    if (name === 'request-id' && /^req_[A-Za-z0-9_-]{1,120}$/.test(value)) headers.set(name, value)
    if (
      name === 'retry-after' &&
      (/^\d{1,10}$/.test(value) ||
        (Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value))
    )
      headers.set(name, value)
    if (
      /^anthropic-ratelimit-(?:(?:requests|tokens|input-tokens|output-tokens)-(?:limit|remaining)|unified-(?:5h|7d)-(?:reset|utilization))$/.test(
        name,
      ) &&
      /^\d+(?:\.\d+)?$/.test(value)
    )
      headers.set(name, value)
    if (
      /^anthropic-ratelimit-unified-(?:(?:5h|7d)-)?status$/.test(name) &&
      ['allowed', 'allowed_warning', 'rejected'].includes(value)
    )
      headers.set(name, value)
  }
  return headers
}

export class ClaudeProxyResponseError extends Error {
  constructor() {
    super('UPSTREAM_RESPONSE_INVALID')
    this.name = 'ClaudeProxyResponseError'
  }
}

export async function readProxyJson(response: Response): Promise<{ readonly value: unknown; readonly text: string }> {
  const reader = response.body?.getReader()
  if (!reader) throw new ClaudeProxyResponseError()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new ClaudeProxyResponseError()
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return { value: JSON.parse(text), text }
  } catch (error) {
    if (error instanceof Error) throw new ClaudeProxyResponseError()
    throw error
  } finally {
    reader.releaseLock()
  }
}
