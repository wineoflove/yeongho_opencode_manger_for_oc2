import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadClaudeInference } from '../../src/services/claude-inference-config'

describe('inference opt-in configuration', () => {
  it('does not enable inference merely because management is configured', async () => {
    expect(
      await loadClaudeInference({
        OCM_CLAUDE_PROXY_URL: 'http://127.0.0.1:5117',
      }),
    ).toBeUndefined()
  })
  it('rejects incomplete inference configuration', async () => {
    await expect(loadClaudeInference({ OCM_CLAUDE_INFERENCE_KEY_FILE: '/private/test' })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
  })
  it.each([true, false])('requires distinct management, upstream and ingress keys: shared=%s', async (shared) => {
    const root = await mkdtemp(join(tmpdir(), 'proxy-inference-config-'))
    try {
      await writeFile(join(root, 'incoming'), 'test-incoming-secret', {
        mode: 0o600,
      })
      await writeFile(join(root, 'upstream'), shared ? 'test-incoming-secret' : 'test-upstream-secret', { mode: 0o600 })
      await writeFile(join(root, 'management'), 'test-management-secret', {
        mode: 0o600,
      })
      const promise = loadClaudeInference({
        OCM_CLAUDE_PROXY_URL: 'http://127.0.0.1:5117',
        OCM_CLAUDE_INFERENCE_KEY_FILE: join(root, 'incoming'),
        OCM_CLAUDE_PROXY_API_KEY_FILE: join(root, 'upstream'),
        OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: join(root, 'management'),
        OCM_CLAUDE_PROXY_GATE_DIRECTORY: join(root, 'uninitialized-gate'),
      })
      if (shared)
        await expect(promise).rejects.toMatchObject({
          code: 'INVALID_CONFIGURATION',
        })
      else {
        const binding = await promise
        expect(binding?.key).toBe('test-incoming-secret')
        await expect(binding?.transport.messages('{}', new AbortController().signal)).rejects.toMatchObject({
          code: 'GATE_UNAVAILABLE',
        })
      }
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
