import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProxyGate } from '../../src/services/claude-proxy-gate'
import { ClaudeProxyTransport } from '../../src/services/claude-proxy-transport'

afterEach(() => vi.restoreAllMocks())

describe('compression inside inference gate lease', () => {
  it.each(['failure', 'cancel'] as const)('does not send inference after compression %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'compression-lease-'))
    const controller = new AbortController()
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ type: 'message' }))
    try {
      const gate = await ClaudeProxyGate.initialize(join(root, 'gate'))
      const client = new ClaudeProxyTransport(gate, {
        baseUrl: 'http://127.0.0.1:5117',
        apiKey: 'synthetic',
        compression: {
          async compress() {
            if (mode === 'failure') throw new Error('synthetic-compression-error')
            controller.abort()
            return 'compressed'
          },
        },
      })
      await expect(client.messages('original', controller.signal)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      })
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('forwards compressed bytes once and never compresses again after persistent denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compression-denial-'))
    const compress = vi.fn(async () => 'compressed-bytes')
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private', { status: 403 }))
    try {
      const gate = await ClaudeProxyGate.initialize(join(root, 'gate'))
      const client = new ClaudeProxyTransport(gate, {
        baseUrl: 'http://127.0.0.1:5117',
        apiKey: 'synthetic',
        compression: { compress },
      })
      const response = await client.messages('original-bytes', new AbortController().signal)
      expect(response.status).toBe(403)
      expect(upstream.mock.calls[0]?.[1]?.body).toBe('compressed-bytes')
      await expect(client.messages('another', new AbortController().signal)).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
      expect(compress).toHaveBeenCalledTimes(1)
      expect(upstream).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
