import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { readProxyJson } from './claude-proxy-response'

const message = z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() }).passthrough()
const request = z.object({ model: z.string(), messages: z.array(message).min(1) }).passthrough()
const result = z.object({
  body: request,
  obligations: z.array(z.unknown()).length(0),
  headers: z.record(z.string(), z.string()),
})
const compressedText = Symbol('compressed-text')

function protectedContent(value: unknown): unknown {
  if (typeof value === 'string') return compressedText
  if (Array.isArray(value)) return value.map(protectedContent)
  const parsed = z.record(z.string(), z.unknown()).safeParse(value)
  if (!parsed.success) return value
  const block = parsed.data
  if (block.type === 'text') {
    if (typeof block.text !== 'string') throw new ClaudeCompressionError('COMPRESSION_CONTRACT_CHANGED')
    return Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'text'))
  }
  if (block.type === 'tool_result') {
    const { content, ...metadata } = block
    return { ...metadata, content: protectedContent(content) }
  }
  return block
}

function protectedMessage(value: z.infer<typeof message>): unknown {
  const { content, ...metadata } = value
  return { ...metadata, content: protectedContent(content) }
}

export class ClaudeCompressionError extends Error {
  constructor(readonly code: 'INVALID_TARGET' | 'COMPRESSION_UNAVAILABLE' | 'COMPRESSION_CONTRACT_CHANGED') {
    super(code)
    this.name = 'ClaudeCompressionError'
  }
}

export class ClaudeCompression {
  private readonly endpoint: URL

  constructor(baseUrl: string) {
    if (!URL.canParse(baseUrl)) throw new ClaudeCompressionError('INVALID_TARGET')
    const base = new URL(baseUrl)
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw new ClaudeCompressionError('INVALID_TARGET')
    this.endpoint = new URL('/v1/compress', base)
  }

  async compress(text: string, signal: AbortSignal): Promise<string> {
    const original = request.parse(JSON.parse(text))
    if ('config' in original || 'gateway' in original) throw new ClaudeCompressionError('COMPRESSION_CONTRACT_CHANGED')
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...original,
          config: { mode: 'lossless' },
          gateway: {
            can_redrive: false,
            can_relay_response: false,
            session_affinity: false,
          },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new ClaudeCompressionError('COMPRESSION_UNAVAILABLE')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ClaudeCompressionError('COMPRESSION_UNAVAILABLE')
    }
    const parsed = result.safeParse((await readProxyJson(response)).value)
    if (!parsed.success || Object.keys(parsed.data.headers).length)
      throw new ClaudeCompressionError('COMPRESSION_CONTRACT_CHANGED')
    const { messages: before, ...originalOptions } = original
    const { messages: after, ...compressedOptions } = parsed.data.body
    if (
      !isDeepStrictEqual(originalOptions, compressedOptions) ||
      !isDeepStrictEqual(before.map(protectedMessage), after.map(protectedMessage))
    )
      throw new ClaudeCompressionError('COMPRESSION_CONTRACT_CHANGED')
    return JSON.stringify(parsed.data.body)
  }
}
