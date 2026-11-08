import { describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { ScheduleRunSchema } from '@opencode-manager/shared/schemas'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { createScheduleJob, createScheduleRun } from '../../src/db/schedules'
import { buildCreateSchedulePersistenceInput } from '../../src/services/schedule-config'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { GitAuthService } from '../../src/services/git-auth'
import { ScheduleService } from '../../src/services/schedules'
import { ScheduleWorktreeManager } from '../../src/services/schedule-worktree'
import { createScheduleRoutes } from '../../src/routes/schedules'
import { buildManagerToolPluginSource } from '../../src/services/opencode-manager-tool-plugin'
import { ProviderRateLimitStore } from '../../src/services/provider-rate-limit-store'
import { createInternalProviderRateLimitRoutes } from '../../src/routes/internal/provider-rate-limits'
import { createOpenCodeServeDirectories, resolveOpenCode2Binary, startOpenCodeServe } from '../helpers/opencode-binary'
import type { OpenCodeServe } from '../helpers/opencode-binary'

const binary = resolveOpenCode2Binary()
if (process.env.OPENCODE_BIN && binary !== process.env.OPENCODE_BIN) {
  throw new Error('OPENCODE_BIN must resolve to a supported executable for this integration test')
}

describe.skipIf(binary === null)('schedule usage with a real OpenCode server', () => {
  it.each(['available', 'error', 'silent', 'oauth-refresh', 'oauth-refresh-failure'] as const)(
    'preserves root and child usage with HTTP header collector=%s',
    async (collectorState) => {
      const directories = await createOpenCodeServeDirectories()
      const repoPath = join(directories.root, 'repo')
      const db = new Database(':memory:')
      const sessionIds: string[] = []
      const refreshReceipt = join(directories.root, 'oauth-refresh.json')
      let serve: OpenCodeServe | undefined
      let client: FetchOpenCodeClient | undefined
      const observations = new ProviderRateLimitStore()
      const collector = new Hono().route(
        '/api/internal/provider-rate-limits',
        createInternalProviderRateLimitRoutes(observations),
      )
      const receivedHeaders: unknown[] = []
      const disconnectedAfter: number[] = []
      const llm = createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/api/internal/provider-rate-limits') {
          if (request.headers.authorization !== 'Bearer local-observation-token') {
            response.writeHead(401).end()
            return
          }
          let body = ''
          request.on('data', (chunk: Buffer) => {
            body += chunk.toString()
          })
          request.on('end', async () => {
            try {
              receivedHeaders.push(JSON.parse(body))
              if (collectorState === 'silent') {
                const startedAt = performance.now()
                response.once('close', () => disconnectedAfter.push(performance.now() - startedAt))
                return
              }
              if (collectorState === 'error') {
                response.writeHead(503).end('Fixture collector unavailable')
                return
              }
              const collected = await collector.request('/api/internal/provider-rate-limits', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
              })
              response
                .writeHead(collected.status, {
                  'content-type': 'application/json',
                })
                .end(await collected.text())
            } catch {
              response.writeHead(400).end()
            }
          })
          return
        }
        if (request.method === 'GET' && request.url?.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'usage-model', object: 'model' }],
            }),
          )
          return
        }
        if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
          response.writeHead(404).end()
          return
        }
        request.resume()
        request.on('end', () => {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'anthropic-ratelimit-requests-limit': '50',
            'anthropic-ratelimit-requests-remaining': '42',
            'anthropic-ratelimit-unified-5h-utilization': '0.3',
            'anthropic-ratelimit-unified-5h-reset': '1800000000',
            'x-private-fixture': 'must-not-be-collected',
          })
          const base = {
            id: 'chatcmpl-usage',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'usage-model',
          }
          for (const chunk of [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Usage recorded.' },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 40,
                total_tokens: 160,
                prompt_tokens_details: { cached_tokens: 20 },
                completion_tokens_details: { reasoning_tokens: 10 },
              },
            },
          ])
            response.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`)
          response.end('data: [DONE]\n\n')
        })
      })

      try {
        const listening = once(llm, 'listening')
        llm.listen(0, '0.0.0.0')
        await listening
        const address = llm.address()
        if (!address || typeof address === 'string') throw new Error('Fake model did not bind a TCP port')
        await mkdir(repoPath)
        await mkdir(join(directories.configHome, 'opencode'), {
          recursive: true,
        })
        await mkdir(join(directories.configHome, 'opencode', 'plugins'), {
          recursive: true,
        })
        await writeFile(
          join(directories.configHome, 'opencode', 'plugins', 'ocm-manager.js'),
          buildManagerToolPluginSource('ocm.manager'),
        )
        if (collectorState === 'oauth-refresh' || collectorState === 'oauth-refresh-failure') {
          await writeFile(
            join(directories.configHome, 'opencode', 'plugins', 'fixture-oauth.js'),
            `
import { writeFile } from 'node:fs/promises'
export default {
  id: 'fixture.oauth-refresh',
  async setup(ctx) {
    let refreshes = 0
    let observations = 0
    const outcomes = []
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: 'fixture-auth',
        method: { id: 'fixture-method', type: 'oauth', label: 'Fixture only' },
        authorize: async () => { throw new Error('Fixture authorization must not run') },
        refresh: async (credential) => {
          refreshes++
          await new Promise((resolve) => setTimeout(resolve, 50))
          if (${JSON.stringify(collectorState === 'oauth-refresh-failure')} && refreshes === 1) throw new Error('Fixture refresh failure')
          return { ...credential, access: 'fixture-refreshed', refresh: 'fixture-refresh-next', expires: Date.now() + 3600000 }
        },
      })
    })
    await ctx.session.hook('prompt', async () => {
      const connection = await ctx.integration.connection.active('fixture-auth')
      if (!connection) throw new Error('Fixture connection missing')
      const values = await Promise.allSettled([ctx.integration.connection.resolve(connection), ctx.integration.connection.resolve(connection)])
      observations++
      outcomes.push(values.map((result) => result.status))
      const matched = values.every((result) => result.status === 'fulfilled' && result.value?.type === 'oauth' && result.value.access === 'fixture-refreshed')
      await writeFile(${JSON.stringify(refreshReceipt)}, JSON.stringify({ refreshes, observations, matched, outcomes }))
    })
  },
}
`,
          )
        }
        await writeFile(
          join(directories.configHome, 'opencode', 'opencode.json'),
          JSON.stringify({
            autoupdate: false,
            providers: {
              mock: {
                package: '@opencode/ai/providers/openai-compatible',
                name: 'Local usage fixture',
                settings: {
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: 'local-fixture',
                },
                models: {
                  'usage-model': {
                    name: 'Usage fixture',
                    cost: {
                      input: 1,
                      output: 2,
                      cache: { read: 0.5, write: 1 },
                    },
                  },
                },
              },
            },
            model: 'mock/usage-model',
            permissions: [{ action: '*', resource: '*', effect: 'deny' }],
          }),
        )
        serve = await startOpenCodeServe({
          directories,
          env: {
            OPENCODE_DISABLE_CLAUDE_CODE: '1',
            OCM_INTERNAL_API_URL: `http://127.0.0.1:${address.port}/api/internal`,
            OCM_INTERNAL_TOKEN: 'local-observation-token',
          },
        })
        client = new FetchOpenCodeClient({
          baseUrl: serve.baseUrl,
          basicAuth: buildOpenCodeBasicAuth(serve.password),
          defaultDirectory: false,
        })
        const api = client.api
        const refreshCredential =
          collectorState === 'oauth-refresh' || collectorState === 'oauth-refresh-failure'
            ? await api.credential.create({
                integrationID: 'fixture-auth',
                label: 'Expired fixture',
                activate: true,
                value: {
                  type: 'oauth',
                  methodID: 'fixture-method',
                  access: 'fixture-expired',
                  refresh: 'fixture-refresh-old',
                  expires: 1,
                },
              })
            : null
        const root = await api.session.create({
          title: 'Schedule usage root',
          location: { directory: repoPath },
          agent: 'build',
          model: { providerID: 'mock', id: 'usage-model' },
        })
        sessionIds.push(root.id)
        const child = await api.session.create({
          parentID: root.id,
          title: 'Schedule usage child',
          location: { directory: repoPath },
          agent: 'build',
          model: { providerID: 'mock', id: 'usage-model' },
        })
        sessionIds.push(child.id)
        for (const sessionID of sessionIds) {
          await api.session.prompt({
            sessionID,
            text: 'Reply with a short confirmation without using tools.',
          })
          await api.session.wait(
            { sessionID },
            {
              signal: AbortSignal.timeout(collectorState === 'silent' ? 10000 : 60000),
            },
          )
        }

        migrate(db, allMigrations)
        const now = Date.now()
        db.prepare(
          `INSERT INTO repos (id, local_path, source_path, default_branch, clone_status, cloned_at)
        VALUES (1, 'usage-fixture', ?, 'main', 'ready', ?)`,
        ).run(repoPath, now)
        const job = createScheduleJob(
          db,
          1,
          buildCreateSchedulePersistenceInput({
            name: 'Usage recovery',
            prompt: 'Report usage',
            enabled: false,
            scheduleMode: 'interval',
            intervalMinutes: 60,
            model: 'mock/usage-model',
          }),
        )
        const run = createScheduleRun(db, {
          repoId: 1,
          jobId: job.id,
          triggerSource: 'manual',
          status: 'running',
          startedAt: now,
          createdAt: now,
        })
        db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(root.id, run.id)
        const service = new ScheduleService(db, client, new ScheduleWorktreeManager(new GitAuthService(), db))
        const app = new Hono().route('/repos/:id/schedules', createScheduleRoutes(service))

        await service.recoverRunningRuns()

        const response = await app.request(`/repos/1/schedules/${job.id}/runs/${run.id}`)
        expect(response.status).toBe(200)
        const result = z.object({ run: ScheduleRunSchema }).parse(await response.json()).run
        expect(result).toMatchObject({
          status: 'completed',
          responseText: 'Usage recorded.',
          agentUsed: 'build',
        })
        expect(result.usage).toMatchObject({
          sessions: 2,
          error: null,
          additional: null,
          byModel: {
            'mock/usage-model': {
              input: 200,
              output: 60,
              reasoning: 20,
              cacheRead: 40,
              cacheWrite: 0,
              messages: 2,
            },
          },
        })
        expect(result.usage?.byModel['mock/usage-model']?.cost).toBeCloseTo(0.00038, 8)
        expect(result.usage?.totals).toMatchObject({
          input: 200,
          output: 60,
          reasoning: 20,
          cacheRead: 40,
          cacheWrite: 0,
          messages: 2,
        })
        expect(result.usage?.totals.cost).toBeCloseTo(0.00038, 8)
        expect(receivedHeaders.length).toBeGreaterThanOrEqual(2)
        if (collectorState === 'silent') {
          await expect.poll(() => disconnectedAfter.length).toBe(receivedHeaders.length)
          for (const duration of disconnectedAfter) expect(duration).toBeLessThan(5000)
        }
        for (const observation of receivedHeaders) {
          expect(observation).toEqual({
            providerId: 'mock',
            modelId: 'usage-model',
            headers: {
              'anthropic-ratelimit-requests-limit': '50',
              'anthropic-ratelimit-requests-remaining': '42',
              'anthropic-ratelimit-unified-5h-utilization': '0.3',
              'anthropic-ratelimit-unified-5h-reset': '1800000000',
            },
          })
        }
        expect(observations.list('mock')).toMatchObject(
          collectorState === 'available' ||
            collectorState === 'oauth-refresh' ||
            collectorState === 'oauth-refresh-failure'
            ? [
                {
                  accountId: null,
                  stale: false,
                  buckets: [{ resource: 'requests', limit: 50, remaining: 42 }],
                  subscriptionWindows: [
                    { window: 'five_hour', usedPercent: 30, resetAt: 1_800_000_000_000, status: null },
                  ],
                },
              ]
            : [],
        )
        if (refreshCredential) {
          expect(JSON.parse(await readFile(refreshReceipt, 'utf8'))).toEqual({
            refreshes: collectorState === 'oauth-refresh-failure' ? 2 : 1,
            observations: 2,
            matched: true,
            outcomes: [
              collectorState === 'oauth-refresh-failure' ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
              ['fulfilled', 'fulfilled'],
            ],
          })
          const stored = (await api.credential.list()).find((entry) => entry.id === refreshCredential.id)
          expect(stored?.value).toMatchObject({
            type: 'oauth',
            access: 'fixture-refreshed',
            refresh: 'fixture-refresh-next',
          })
        }
      } finally {
        try {
          if (client) {
            for (const sessionID of sessionIds.toReversed()) {
              await client.api.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5000) })
              await client.api.session.remove({ sessionID }, { signal: AbortSignal.timeout(5000) })
            }
          }
        } finally {
          try {
            await serve?.terminate()
          } finally {
            llm.closeAllConnections()
            await new Promise<void>((resolve, reject) => llm.close((error) => (error ? reject(error) : resolve())))
            db.close()
            await rm(directories.root, { recursive: true, force: true })
          }
        }
      }
    },
    180000,
  )
})
