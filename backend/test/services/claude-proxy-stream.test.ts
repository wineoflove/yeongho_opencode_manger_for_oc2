import { describe, expect, it } from 'vitest'
import { ClaudeProxyStreamDecoder } from '../../src/services/claude-proxy-stream'

describe('Claude SSE boundary', () => {
  it('retains a completed denial before invalid UTF-8 in the same chunk', () => {
    const bytes = Buffer.concat([
      Buffer.from('data: {"type":"error","error":{"type":"permission_error"}}\n\n'),
      Buffer.from([255]),
    ])
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new ClaudeProxyStreamDecoder()
      const frames = [...decoder.push(bytes.subarray(0, split))]
      if (!frames.some((frame) => frame.terminal)) frames.push(...decoder.push(bytes.subarray(split)))
      expect(frames).toHaveLength(1)
      expect(frames[0]?.denied).toBe(true)
    }
  })
  it('preserves a denial decision when trailing data is malformed', () => {
    const decoder = new ClaudeProxyStreamDecoder()
    const frames = decoder.push(
      new TextEncoder().encode('data: {"type":"error","error":{"type":"permission_error"}}\n\ndata: malformed\n\n'),
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]?.denied).toBe(true)
    decoder.finish()
  })
  it('preserves ordinary text across every byte boundary', () => {
    const wire = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"안녕"}}\n\n'
    const bytes = new TextEncoder().encode(wire)
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoder = new ClaudeProxyStreamDecoder()
      const frames = [...decoder.push(bytes.slice(0, cut)), ...decoder.push(bytes.slice(cut))]
      decoder.finish()
      expect(frames.map((frame) => frame.text).join('')).toBe(wire)
      expect(frames.every((frame) => !frame.denied)).toBe(true)
    }
  })

  it.each(['\n', '\r\n', '\r'])('buffers and sanitizes permission errors split at every byte (%j)', (newline) => {
    const wire = `event: error${newline}data: {"type":"error","error":{"type":"permission_error","message":"private-token-value"}}${newline}${newline}`
    const bytes = new TextEncoder().encode(wire)
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoder = new ClaudeProxyStreamDecoder()
      const frames = [...decoder.push(bytes.slice(0, cut)), ...decoder.push(bytes.slice(cut))]
      frames.push(...decoder.finish())
      expect(frames).toEqual([
        {
          text: 'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"Upstream stream failed."}}\n\n',
          denied: true,
          terminal: true,
        },
      ])
    }
  })

  it('does not confuse model text mentioning permission_error with a denial', () => {
    const decoder = new ClaudeProxyStreamDecoder()
    const wire = 'data: {"type":"content_block_delta","delta":{"text":"permission_error"}}\n\n'
    expect(decoder.push(new TextEncoder().encode(wire))).toEqual([{ text: wire, denied: false }])
    decoder.finish()
  })

  it('fails on malformed and truncated events without returning raw payloads', () => {
    const decoder = new ClaudeProxyStreamDecoder()
    expect(() => decoder.push(new TextEncoder().encode('data: private-invalid-json\n\n'))).toThrow(
      'UPSTREAM_STREAM_INVALID',
    )
    const truncated = new ClaudeProxyStreamDecoder()
    expect(truncated.push(new TextEncoder().encode('data: {"type":"error"'))).toEqual([])
    expect(() => truncated.finish()).toThrow('UPSTREAM_STREAM_INVALID')
  })
})
