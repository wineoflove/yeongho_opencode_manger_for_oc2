import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCompression } from '../../src/services/claude-compression'

const original = {
  model: 'claude-opus-5-5',
  max_tokens: 100,
  stream: true,
  tools: [{ name: 'read', input_schema: { type: 'object' } }],
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'protected', signature: 'signature' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'read',
          input: { path: 'file' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'long synthetic text',
        },
        { type: 'image', source: { type: 'base64', data: 'synthetic' } },
      ],
    },
  ],
}
const endpoint = new ClaudeCompression('http://127.0.0.1:18787')
const invoke = () => endpoint.compress(JSON.stringify(original), new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

describe('Claude compression contract', () => {
  it('accepts text compression while retaining request options and structured content', async () => {
    const compressed = structuredClone(original)
    const result = compressed.messages[1]?.content[0]
    if (!result || !('content' in result)) throw new Error('missing_tool_result')
    result.content = 'short'
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        body: compressed,
        obligations: [],
        headers: {},
      }),
    )
    expect(JSON.parse(await invoke())).toEqual(compressed)
    const call = fetcher.mock.calls[0]
    expect(call).toBeDefined()
    if (!call) throw new Error('missing_request')
    expect(new Headers(call[1]?.headers).get('authorization')).toBeNull()
    expect(new Headers(call[1]?.headers).get('x-api-key')).toBeNull()
    expect(JSON.parse(String(call[1]?.body)).gateway).toEqual({
      can_redrive: false,
      can_relay_response: false,
      session_affinity: false,
    })
  })

  it.each(['model', 'tools', 'tool-id', 'signature', 'image', 'role', 'obligations', 'headers', 'null-content'])(
    'rejects changed protected field %s',
    async (field) => {
      const payload = JSON.parse(JSON.stringify({ body: original, obligations: [], headers: {} }))
      switch (field) {
        case 'model':
          payload.body.model = 'other'
          break
        case 'tools':
          payload.body.tools = []
          break
        case 'tool-id':
          payload.body.messages[1].content[0].tool_use_id = 'other'
          break
        case 'signature':
          payload.body.messages[0].content[0].signature = 'other'
          break
        case 'image':
          payload.body.messages[1].content[1].source.data = 'other'
          break
        case 'null-content':
          payload.body.messages[1].content[0].content = null
          break
        case 'role':
          payload.body.messages[1].role = 'assistant'
          break
        case 'obligations':
          payload.obligations = ['retrieve']
          break
        case 'headers':
          payload.headers = { authorization: 'unexpected' }
          break
        default:
          throw new Error('unknown_case')
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload))
      await expect(invoke()).rejects.toMatchObject({
        code: 'COMPRESSION_CONTRACT_CHANGED',
      })
    },
  )

  it.each([403, 500])('rejects compression status %s without retry', async (status) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private detail', { status }))
    await expect(invoke()).rejects.toMatchObject({
      code: 'COMPRESSION_UNAVAILABLE',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
