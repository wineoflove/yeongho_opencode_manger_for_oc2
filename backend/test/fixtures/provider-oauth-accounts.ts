import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { createOAuthRoutes } from '../../src/routes/oauth'
import { createProvidersRoutes } from '../../src/routes/providers'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { createOpenCodeServeDirectories, startOpenCodeServe } from '../helpers/opencode-binary'
import type { OpenCodeServe } from '../helpers/opencode-binary'

export async function createOAuthAccountsFixture() {
  const directories = await createOpenCodeServeDirectories()
  const repoPath = join(directories.root, 'repo')
  const resolvePath = join(directories.root, 'resolve.json')
  const receiptPath = join(directories.root, 'receipt.json')
  const markers: string[] = []
  let serve: OpenCodeServe | undefined
  const llm = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    markers.push(request.headers.authorization ?? 'missing')
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: 'oauth-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
      }
      for (const choices of [
        [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Fixture reply.' },
            finish_reason: null,
          },
        ],
        [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ])
        response.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  const dispose = async () => {
    try {
      await serve?.terminate()
    } finally {
      try {
        if (llm.listening) {
          llm.closeAllConnections()
          await new Promise<void>((resolve, reject) => llm.close((error) => (error ? reject(error) : resolve())))
        }
      } finally {
        await rm(directories.root, { recursive: true, force: true })
      }
    }
  }
  try {
    const listening = once(llm, 'listening')
    llm.listen(0, '0.0.0.0')
    await listening
    const address = llm.address()
    if (!address || typeof address === 'string') throw new Error('Fixture model TCP address missing')
    const pluginPath = join(directories.configHome, 'opencode', 'plugins')
    await mkdir(pluginPath, { recursive: true })
    await mkdir(repoPath)
    await writeFile(resolvePath, JSON.stringify(null))
    await writeFile(
      join(pluginPath, 'fixture-oauth.js'),
      `
import { readFile, writeFile } from 'node:fs/promises'
export default {
  id: 'fixture.oauth-accounts',
  async setup(ctx) {
    const refreshed = []
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: 'fixture-auth',
        method: { type: 'key' },
      })
      editor.method.update({
        integrationID: 'fixture-auth',
        method: { id: 'fixture-code', type: 'oauth', label: 'Local fixture' },
        authorize: async () => ({
          mode: 'code',
          url: 'http://127.0.0.1:${address.port}/authorize',
          instructions: 'Enter a fixture account name.',
          callback: async (code) => {
            if (!['first', 'second', 'first-expired'].includes(code)) throw new Error('Unknown fixture account')
            const account = code === 'first-expired' ? 'first' : code
            return { type: 'oauth', methodID: 'fixture-code', access: 'fixture-access-' + account,
              refresh: 'fixture-refresh-' + account, expires: code === 'first-expired' ? 1 : Date.now() + 3600000 }
          },
        }),
        refresh: async (credential) => {
          refreshed.push(credential.refresh)
          return { ...credential, access: credential.access + '-renewed',
            refresh: credential.refresh + '-renewed', expires: Date.now() + 3600000 }
        },
      })
    })
    await ctx.session.hook('prompt', async () => {
      const id = JSON.parse(await readFile(${JSON.stringify(resolvePath)}, 'utf8'))
      if (!id) return
      const value = await ctx.integration.connection.resolve({ type: 'credential', id })
      await writeFile(${JSON.stringify(receiptPath)}, JSON.stringify({ refreshed, value }))
    })
  },
}
`,
    )
    await writeFile(
      join(directories.configHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        autoupdate: false,
        providers: {
          'fixture-auth': {
            package: '@opencode/ai/providers/openai-compatible',
            name: 'Local OAuth fixture',
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { 'fixture-model': { name: 'Fixture model' } },
          },
        },
        model: 'fixture-auth/fixture-model',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      }),
    )
    serve = await startOpenCodeServe({
      directories,
      env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
    })
    const client = new FetchOpenCodeClient({
      baseUrl: serve.baseUrl,
      basicAuth: buildOpenCodeBasicAuth(serve.password),
      defaultDirectory: false,
    })
    const app = new Hono().route('/oauth', createOAuthRoutes(client)).route('/providers', createProvidersRoutes(client))
    return {
      app,
      api: client.api,
      markers,
      dispose,
      resolveCredential: async (id: string) => writeFile(resolvePath, JSON.stringify(id)),
      receipt: async () => JSON.parse(await readFile(receiptPath, 'utf8')) as unknown,
      prompt: async () => {
        const session = await client.api.session.create({
          title: 'OAuth account fixture',
          location: { directory: repoPath },
          agent: 'build',
          model: { providerID: 'fixture-auth', id: 'fixture-model' },
        })
        await client.api.session.prompt({
          sessionID: session.id,
          text: 'Reply briefly without tools.',
        })
        await client.api.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) })
        return session.id
      },
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
