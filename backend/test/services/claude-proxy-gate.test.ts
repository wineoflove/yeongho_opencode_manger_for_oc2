import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeProxyGate } from '../../src/services/claude-proxy-gate'

describe('persistent Claude proxy admission', () => {
  it('persists denial across instance recreation and aborts concurrent leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxy-gate-'))
    try {
      const path = join(root, 'gate')
      const gate = await ClaudeProxyGate.initialize(path)
      const a = await gate.acquire(new AbortController().signal)
      const b = await gate.acquire(new AbortController().signal)
      await gate.deny()
      expect([a.signal.aborted, b.signal.aborted]).toEqual([true, true])
      await expect(new ClaudeProxyGate(path).acquire(new AbortController().signal)).rejects.toMatchObject({
        code: 'PROXY_BLOCKED',
      })
      a.release()
      b.release()
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it.each(['missing', 'corrupt', 'partial-denial'])('fails closed on %s state', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'proxy-gate-'))
    try {
      const path = join(root, 'gate')
      switch (kind) {
        case 'missing':
          break
        case 'corrupt':
          await ClaudeProxyGate.initialize(path)
          await writeFile(join(path, 'ready.json'), '{')
          break
        case 'partial-denial':
          await ClaudeProxyGate.initialize(path)
          await writeFile(join(path, 'blocked'), '')
          break
        default:
          throw new Error('unexpected_case')
      }
      await expect(new ClaudeProxyGate(path).acquire(new AbortController().signal)).rejects.toMatchObject({
        code: kind === 'partial-denial' ? 'PROXY_BLOCKED' : 'GATE_UNAVAILABLE',
      })
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('keeps the current process blocked if durable denial cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proxy-gate-'))
    try {
      const path = join(root, 'gate')
      const gate = await ClaudeProxyGate.initialize(path)
      const active = await gate.acquire(new AbortController().signal)
      await rename(path, join(root, 'moved'))
      await expect(gate.deny()).rejects.toMatchObject({
        code: 'GATE_UNAVAILABLE',
      })
      expect(active.signal.aborted).toBe(true)
      await expect(gate.acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'PROXY_BLOCKED' })
      active.release()
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
