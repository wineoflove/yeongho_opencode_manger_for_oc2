import { describe, expect, it } from 'vitest'
import { CLAUDE_REQUEST_LIMIT, createClaudeInferenceRoutes } from '../../src/routes/claude-inference'
import { ClaudeProxyGateError } from '../../src/services/claude-proxy-gate'
import { Hono } from 'hono'
import { maintenanceAdmission, maintenanceHttpAdmission } from '../../src/services/maintenance-admission'

const key = 'fixture-incoming-key'
const body = JSON.stringify({
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'OK' }],
  stream: true,
})

describe('Claude inference ingress', () => {
  it('preserves authenticated followups and exact body during enter, but never invokes transport after seal', async () => {
    const received: string[] = []
    const app = new Hono()
    app.use('/api/*', maintenanceHttpAdmission(maintenanceAdmission))
    app.route('/api/claude-inference', createClaudeInferenceRoutes({ key, transport: {
      messages: async (text) => { received.push(text); return new Response('ok') },
    } }))
    const request = () => app.request('/api/claude-inference/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body,
    })
    expect((await request()).status).toBe(200)
    try {
      maintenanceAdmission.enter('inference-ingress-owner')
      expect((await request()).status).toBe(200)
      maintenanceAdmission.seal('inference-ingress-owner')
      expect((await request()).status).toBe(503)
      expect(received).toEqual([body, body])
    } finally { maintenanceAdmission.exit('inference-ingress-owner') }
    expect((await request()).status).toBe(200)
  })
  it('requires the inference key before invoking transport', async () => {
    let calls = 0
    const app = createClaudeInferenceRoutes({
      key,
      transport: {
        messages: async () => {
          calls++
          return new Response('OK')
        },
      },
    })
    for (const supplied of ['', 'fixture-management-key', 'fixture-upstream-key']) {
      const response = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': supplied, 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(401)
    }
    expect(calls).toBe(0)
  })

  it('forwards valid request bytes without an account-selection override', async () => {
    const received: string[] = []
    const app = createClaudeInferenceRoutes({
      key,
      transport: {
        messages: async (text) => {
          received.push(text)
          return new Response('data: done\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      },
    })
    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body,
    })
    expect(await response.text()).toBe('data: done\n\n')
    expect(received).toEqual([body])
  })

  it.each([
    { payload: '{', mime: 'application/json', status: 400 },
    {
      payload: JSON.stringify({ model: 'other-provider', messages: [{}] }),
      mime: 'application/json',
      status: 400,
    },
    { payload: body, mime: 'text/plain', status: 415 },
  ])('rejects invalid requests without transport: $status', async ({ payload, mime, status }) => {
    let calls = 0
    const app = createClaudeInferenceRoutes({
      key,
      transport: {
        messages: async () => {
          calls++
          return new Response('unexpected')
        },
      },
    })
    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': mime },
      body: payload,
    })
    expect(response.status).toBe(status)
    expect(calls).toBe(0)
  })

  it.each([true, false])('limits payload size with content-length present=%s', async (length) => {
    let calls = 0
    const app = createClaudeInferenceRoutes({
      key,
      transport: {
        messages: async () => {
          calls++
          return new Response('unexpected')
        },
      },
    })
    const headers = new Headers({
      'x-api-key': key,
      'content-type': 'application/json',
    })
    if (length) headers.set('content-length', String(CLAUDE_REQUEST_LIMIT + 1))
    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers,
      body: length ? body : new Uint8Array(CLAUDE_REQUEST_LIMIT + 1),
    })
    expect(response.status).toBe(413)
    expect(calls).toBe(0)
  })

  it('maps persistent denial to a safe API response', async () => {
    const app = createClaudeInferenceRoutes({
      key,
      transport: {
        messages: async () => {
          throw new ClaudeProxyGateError('PROXY_BLOCKED')
        },
      },
    })
    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body,
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        type: 'permission_error',
        message: 'Inference paused after access denial.',
      },
    })
  })
})
