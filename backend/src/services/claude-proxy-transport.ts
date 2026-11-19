import { ClaudeProxyGate } from './claude-proxy-gate'
import type { ClaudeCompression } from './claude-compression'
import { ClaudeProxyStreamDecoder } from './claude-proxy-stream'
import {
  proxyEnvelopeSchema,
  proxyErrorStatus,
  readProxyJson,
  safeProxyError,
  safeProxyHeaders,
} from './claude-proxy-response'
import { logger } from '../utils/logger'
import { maintenanceAdmission } from './maintenance-admission'

const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 240_000

export class ClaudeProxyTransportError extends Error {
  constructor(readonly code: 'INVALID_TARGET' | 'UPSTREAM_UNAVAILABLE') {
    super(code)
    this.name = 'ClaudeProxyTransportError'
  }
}

export class ClaudeProxyTransport {
  private readonly endpoint: URL

  constructor(
    private readonly gate: ClaudeProxyGate,
    private readonly settings: {
      readonly baseUrl: string
      readonly apiKey: string
      readonly compression?: Pick<ClaudeCompression, 'compress'>
      readonly headersTimeoutMs?: number
      readonly streamIdleTimeoutMs?: number
    },
  ) {
    const base = new URL(settings.baseUrl)
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash ||
      !settings.apiKey
    )
      throw new ClaudeProxyTransportError('INVALID_TARGET')
    this.endpoint = new URL('/v1/messages', base)
  }

  async messages(body: string, signal: AbortSignal): Promise<Response> {
    const releaseAdmission = maintenanceAdmission.admitInference()
    let gateLease: Awaited<ReturnType<ClaudeProxyGate['acquire']>>
    try {
      gateLease = await this.gate.acquire(signal)
    } catch (error) {
      releaseAdmission()
      throw error
    }
    const lease = {
      signal: gateLease.signal,
      release: () => { gateLease.release(); releaseAdmission() },
    }
    const {
      headersTimeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
      streamIdleTimeoutMs = UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
    } = this.settings
    const deadline = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (milliseconds: number, phase: 'headers' | 'body' | 'stream') => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        logger.warn(`Claude proxy upstream ${phase} timed out after ${milliseconds}ms`)
        deadline.abort()
      }, milliseconds)
    }
    const disarm = () => clearTimeout(timer)
    let response: Response
    try {
      const outgoing = this.settings.compression ? await this.settings.compression.compress(body, lease.signal) : body
      lease.signal.throwIfAborted()
      arm(headersTimeoutMs, 'headers')
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.settings.apiKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: outgoing,
        signal: AbortSignal.any([lease.signal, deadline.signal]),
        redirect: 'error',
      })
    } catch (error) {
      lease.release()
      if (error instanceof Error) throw new ClaudeProxyTransportError('UPSTREAM_UNAVAILABLE')
      throw error
    } finally {
      disarm()
    }
    if (response.status === 403) {
      try {
        await this.gate.deny()
      } finally {
        lease.release()
      }
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'Provider access denied. Proxy paused.',
          },
        },
        { status: 403 },
      )
    }
    if (response.status >= 400) {
      try {
        await response.body?.cancel()
      } finally {
        lease.release()
      }
      return Response.json(
        {
          type: 'error',
          error: {
            type: response.status === 429 ? 'rate_limit_error' : 'api_error',
            message: 'Upstream request failed.',
          },
        },
        {
          status: response.status,
          headers: safeProxyHeaders(response.headers),
        },
      )
    }
    if (!response.body) {
      lease.release()
      return new Response(null, { status: response.status })
    }
    const headers = safeProxyHeaders(response.headers)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      arm(streamIdleTimeoutMs, 'body')
      try {
        const payload = await readProxyJson(response)
        const parsed = proxyEnvelopeSchema.safeParse(payload.value)
        if (!parsed.success) throw new ClaudeProxyTransportError('UPSTREAM_UNAVAILABLE')
        if (parsed.data.type === 'error') {
          const error = safeProxyError(parsed.data.error?.type)
          if (error.error.type === 'permission_error') await this.gate.deny()
          return Response.json(error, {
            status: proxyErrorStatus(error.error.type),
            headers,
          })
        }
        if (parsed.data.type !== 'message') throw new ClaudeProxyTransportError('UPSTREAM_UNAVAILABLE')
        headers.set('content-type', 'application/json')
        return new Response(payload.text, { status: response.status, headers })
      } finally {
        disarm()
        lease.release()
      }
    }
    if (!contentType.includes('text/event-stream')) {
      lease.release()
      throw new ClaudeProxyTransportError('UPSTREAM_UNAVAILABLE')
    }
    const reader = response.body.getReader()
    const decoder = new ClaudeProxyStreamDecoder()
    const encoder = new TextEncoder()
    const gate = this.gate
    const deliver = async (
      frames: ReturnType<ClaudeProxyStreamDecoder['push']>,
      controller: ReadableStreamDefaultController<Uint8Array>,
    ) => {
      for (const frame of frames) {
        if (frame.denied) await gate.deny()
        controller.enqueue(encoder.encode(frame.text))
        if (frame.terminal) {
          await reader.cancel().catch(() => undefined)
          lease.release()
          controller.close()
          return true
        }
      }
      return false
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        arm(streamIdleTimeoutMs, 'stream')
        try {
          const part = await reader.read()
          disarm()
          if (part.done) {
            if (await deliver(decoder.finish(), controller)) return
            lease.release()
            controller.close()
          } else await deliver(decoder.push(part.value), controller)
        } catch (error) {
          disarm()
          await reader.cancel().catch(() => undefined)
          lease.release()
          controller.error(error instanceof Error ? new ClaudeProxyTransportError('UPSTREAM_UNAVAILABLE') : error)
        }
      },
      async cancel() {
        disarm()
        try {
          await reader.cancel()
        } finally {
          lease.release()
        }
      },
    })
    headers.set('content-type', 'text/event-stream')
    return new Response(stream, { status: response.status, headers })
  }
}
