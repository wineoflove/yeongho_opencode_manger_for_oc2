import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { ClaudeProxyGateError } from '../services/claude-proxy-gate'
import type { ClaudeProxyTransport } from '../services/claude-proxy-transport'
import { logger } from '../utils/logger'

const requestSchema = z.object({
  model: z.string().regex(/^claude-[a-z0-9.-]+$/),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
})
export const CLAUDE_REQUEST_LIMIT = 32 * 1024 * 1024

export type ClaudeInferenceBinding = {
  readonly key: string
  readonly transport: Pick<ClaudeProxyTransport, 'messages'>
}

class RequestLimitError extends Error {}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > CLAUDE_REQUEST_LIMIT) {
        await reader.cancel()
        throw new RequestLimitError()
      }
      text += decoder.decode(part.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function createClaudeInferenceRoutes(binding?: ClaudeInferenceBinding) {
  const app = new Hono()
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const expected = binding ? digest(binding.key) : null
  app.post('/v1/messages', async (c) => {
    if (!binding || !expected)
      return c.json(
        {
          error: {
            type: 'api_error',
            message: 'Inference proxy is not configured.',
          },
        },
        503,
      )
    const supplied = c.req.header('x-api-key') ?? ''
    if (!timingSafeEqual(expected, digest(supplied)))
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Invalid inference key.',
          },
        },
        401,
      )
    const length = c.req.header('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > CLAUDE_REQUEST_LIMIT))
      return c.json({ error: { type: 'request_too_large', message: 'Request too large.' } }, 413)
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json'))
      return c.json({ error: { type: 'invalid_request_error', message: 'JSON required.' } }, 415)
    let text: string
    try {
      text = await readBody(c.req.raw)
      if (!requestSchema.safeParse(JSON.parse(text)).success)
        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message: 'Invalid Claude request.',
            },
          },
          400,
        )
    } catch (error) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid Claude request.',
          },
        },
        error instanceof RequestLimitError ? 413 : 400,
      )
    }
    try {
      return await binding.transport.messages(text, c.req.raw.signal)
    } catch (error) {
      logger.warn('Claude inference gateway request failed')
      const blocked = error instanceof ClaudeProxyGateError && error.code === 'PROXY_BLOCKED'
      return c.json(
        {
          error: {
            type: blocked ? 'permission_error' : 'api_error',
            message: blocked ? 'Inference paused after access denial.' : 'Inference unavailable.',
          },
        },
        blocked ? 403 : 503,
      )
    }
  })
  return app
}
