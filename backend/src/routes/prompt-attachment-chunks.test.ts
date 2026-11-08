import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createPromptAttachmentRoutes } from './prompt-attachments'

const env = vi.hoisted(() => ({ workspace: '' }))
vi.mock('@opencode-manager/shared/config/env', () => ({
  getWorkspacePath: () => env.workspace,
  getReposPath: () => join(env.workspace, 'repos'),
}))
const startedSchema = z.object({ uploadId: z.string() })
const completedSchema = z.object({ path: z.string(), size: z.number() })

describe('chunked prompt uploads', () => {
  beforeEach(async () => {
    env.workspace = await mkdtemp(join(tmpdir(), 'prompt-chunks-'))
  })
  afterEach(async () => {
    await rm(env.workspace, { recursive: true, force: true })
  })

  async function start(app: ReturnType<typeof createPromptAttachmentRoutes>, size: number) {
    const response = await app.request('/chunks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '../../sample.bin', directory: env.workspace, size }),
    })
    expect(response.status).toBe(200)
    return startedSchema.parse(await response.json()).uploadId
  }

  it('assembles original bytes and exposes the final path only after completion', async () => {
    const app = createPromptAttachmentRoutes()
    const id = await start(app, 4)
    const response = await app.request(`/chunks/${id}?offset=0`, { method: 'PUT', body: new Uint8Array([0, 255]) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: 2 })
    expect((await app.request(`/chunks/${id}/complete`, { method: 'POST' })).status).toBe(409)
    expect(
      (await app.request(`/chunks/${id}?offset=2`, { method: 'PUT', body: new Uint8Array([128, 1]) })).status,
    ).toBe(200)
    const result = completedSchema.parse(await (await app.request(`/chunks/${id}/complete`, { method: 'POST' })).json())
    expect(await readFile(result.path)).toEqual(Buffer.from([0, 255, 128, 1]))
    expect(result.size).toBe(4)
    expect(result.path.startsWith(`${join(env.workspace, 'repos', '.attachments')}/`)).toBe(true)
    expect((await app.request(`/chunks/${id}/complete`, { method: 'POST' })).status).toBe(404)
  })

  it('accepts a 500MB declaration but rejects anything larger before storing', async () => {
    const app = createPromptAttachmentRoutes()
    const response = await app.request('/chunks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'huge.bin', directory: env.workspace, size: 500 * 1024 * 1024 + 1 }),
    })
    expect(response.status).toBe(400)
    expect(await readdir(env.workspace)).toEqual([])
    const id = await start(app, 500 * 1024 * 1024)
    expect((await app.request(`/chunks/${id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('rejects wrong offsets, oversize chunks and excess bytes', async () => {
    const app = createPromptAttachmentRoutes()
    const id = await start(app, 4)
    expect((await app.request(`/chunks/${id}?offset=1`, { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(409)
    expect(
      (await app.request(`/chunks/${id}?offset=0`, { method: 'PUT', body: new Uint8Array(8 * 1024 * 1024 + 1) }))
        .status,
    ).toBe(413)
    expect((await app.request(`/chunks/${id}`, { method: 'DELETE' })).status).toBe(204)
    const second = await start(app, 4)
    expect((await app.request(`/chunks/${second}?offset=0`, { method: 'PUT', body: new Uint8Array(5) })).status).toBe(
      413,
    )
    expect((await app.request(`/chunks/${second}`, { method: 'DELETE' })).status).toBe(204)
    expect(await readdir(join(env.workspace, 'repos', '.attachments'))).toEqual([])
  })
})
