import { proxyEnvelopeSchema, safeProxyError } from './claude-proxy-response'

export class ClaudeProxyStreamError extends Error {
  constructor() {
    super('UPSTREAM_STREAM_INVALID')
    this.name = 'ClaudeProxyStreamError'
  }
}

export type ClaudeProxyFrame = {
  readonly text: string
  readonly denied: boolean
  readonly terminal?: boolean
}

export class ClaudeProxyStreamDecoder {
  private readonly decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  })
  private pending = ''
  private frame = ''
  private ended = false

  push(chunk: Uint8Array): readonly ClaudeProxyFrame[] {
    if (this.ended) {
      if (chunk.length === 0) return []
      throw new ClaudeProxyStreamError()
    }
    this.pending += Buffer.from(chunk).toString('latin1')
    const frames: ClaudeProxyFrame[] = []
    for (;;) {
      const boundary = /\r\n|\r(?!$)|\n/.exec(this.pending)
      if (!boundary) break
      const line = this.pending.slice(0, boundary.index)
      this.frame += this.pending.slice(0, boundary.index + boundary[0].length)
      this.pending = this.pending.slice(boundary.index + boundary[0].length)
      if (this.frame.length > 4 * 1024 * 1024) throw new ClaudeProxyStreamError()
      if (line !== '') continue
      const frame = this.parse(this.frame)
      frames.push(frame)
      this.frame = ''
      if (frame.terminal) {
        this.pending = ''
        this.ended = true
        break
      }
    }
    if (this.frame.length + this.pending.length > 4 * 1024 * 1024) throw new ClaudeProxyStreamError()
    return frames
  }

  finish(): readonly ClaudeProxyFrame[] {
    this.ended = true
    if (this.pending === '\r') {
      const frame = this.parse(this.frame + '\r')
      this.pending = ''
      this.frame = ''
      return [frame]
    }
    if (this.pending || this.frame) throw new ClaudeProxyStreamError()
    return []
  }

  private parse(frame: string): ClaudeProxyFrame {
    const decodedFrame = this.decoder.decode(Buffer.from(frame, 'latin1'))
    const lines = decodedFrame.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) return { text: decodedFrame, denied: false }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new ClaudeProxyStreamError()
    }
    const result = proxyEnvelopeSchema.safeParse(parsed)
    if (!result.success) throw new ClaudeProxyStreamError()
    if (result.data.type !== 'error' && !lines.some((line) => /^event: ?error$/.test(line)))
      return { text: decodedFrame, denied: false }
    const error = safeProxyError(result.data.error?.type)
    return {
      text: `event: error\ndata: ${JSON.stringify(error)}\n\n`,
      denied: error.error.type === 'permission_error',
      terminal: true,
    }
  }
}
