import { strict as assert } from 'node:assert'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { FILE_LIMITS, getReposPath } from '@opencode-manager/shared/config/env'
import { createHttpServer } from '../../src/utils/http-server'
import { createFileRoutes } from '../../src/routes/files'
import { createPreviewGatewayApp, PreviewSessionStore } from '../../src/services/preview/gateway'

const size = 128 * 1024 * 1024
assert.equal(FILE_LIMITS.MAX_UPLOAD_SIZE_BYTES, size)
const directory = join(getReposPath(), 'upload')
await mkdir(directory, { recursive: true })
const app = new Hono()
app.route(
  '/api/files',
  createFileRoutes(() => [{ localPath: 'upload' }]),
)
app.post('/stream', async (c) => {
  let received = 0
  if (!c.req.raw.body) return c.text('Missing body', 400)
  for await (const chunk of c.req.raw.body) received += chunk.byteLength
  return c.json({ received })
})
const server = await createHttpServer(app).start({
  port: 0,
  hostname: '0.0.0.0',
})
const store = new PreviewSessionStore()
const gateway = await createPreviewGatewayApp(store).start({
  port: 0,
  hostname: '0.0.0.0',
})

function payload(length: number, prefix = '', suffix = ''): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024).fill(97)
  let remaining = length
  return new ReadableStream({
    start(controller) {
      if (prefix) controller.enqueue(new TextEncoder().encode(prefix))
    },
    pull(controller) {
      if (remaining > 0) {
        const count = Math.min(remaining, chunk.byteLength)
        controller.enqueue(chunk.subarray(0, count))
        remaining -= count
      } else {
        if (suffix) controller.enqueue(new TextEncoder().encode(suffix))
        controller.close()
      }
    },
  })
}

try {
  if (process.argv[2] === 'upload') {
    const prefix =
      '--boundary\r\nContent-Disposition: form-data; name="file"; filename="limit.txt"\r\nContent-Type: text/plain\r\n\r\n'
    const suffix = '\r\n--boundary--\r\n'
    for (const bytes of [size, size + 1]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/files/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=boundary',
          'content-length': String(prefix.length + bytes + suffix.length),
        },
        body: payload(bytes, prefix, suffix),
        duplex: 'half',
        signal: AbortSignal.timeout(20000),
      })
      if (bytes === size) {
        assert.equal(response.status, 200)
        assert.equal((await stat(join(directory, 'limit.txt'))).size, size)
        assert.deepEqual(await response.json(), {
          name: 'limit.txt',
          path: 'upload/limit.txt',
          size,
          mimeType: 'text/plain;charset=utf-8',
        })
      } else {
        assert.equal(response.status, 500)
        assert.deepEqual(await response.json(), { error: 'File too large' })
      }
    }
  } else {
    const token = store.issueStartToken({
      port: server.port,
      host: '127.0.0.1',
    })
    const session = store.consumeStartToken(token)
    const response = await fetch(`http://127.0.0.1:${gateway.port}/stream`, {
      method: 'POST',
      headers: { cookie: `ocm_preview=${session}` },
      body: payload(size + 1),
      duplex: 'half',
      signal: AbortSignal.timeout(20000),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: size + 1 })
  }
} finally {
  await gateway.close()
  await server.close()
}
