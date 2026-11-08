import { describe, expect, it, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { createScheduleJob, createScheduleRun, getScheduleRunById } from '../../src/db/schedules'
import { buildCreateSchedulePersistenceInput } from '../../src/services/schedule-config'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import * as upstream from '../../src/services/opencode/upstream'
import { ScheduleService } from '../../src/services/schedules'
import { ScheduleWorktreeManager } from '../../src/services/schedule-worktree'
import { GitAuthService } from '../../src/services/git-auth'
import { sseAggregator } from '../../src/services/sse-aggregator'
import { createOpenCodeServeDirectories, resolveOpenCode2Binary, startOpenCodeServe } from '../helpers/opencode-binary'
import type { OpenCodeServe } from '../helpers/opencode-binary'

const binary = resolveOpenCode2Binary()
const permissionEnvelope = z.object({
  payload: z.object({
    type: z.literal('permission.asked'),
    data: z.object({
      id: z.string(),
      sessionID: z.string(),
      action: z.string(),
    }),
  }),
})

const toolResult = z.object({ error: z.object({ type: z.string() }).optional() })

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

const scenarios = [
  { name: 'a graceful OpenCode restart then a once approval', stop: 'terminate', decision: 'once', managerCrash: false },
  { name: 'a forced OpenCode kill then a rejection', stop: 'kill', decision: 'reject', managerCrash: false },
  {
    name: 'a Manager crash that loses process state and reopens its database, with a forced OpenCode kill, then a once approval',
    stop: 'kill',
    decision: 'once',
    managerCrash: true,
  },
] as const

describe.skipIf(binary === null)('scheduled permission continuity', () => {
  it.each(scenarios)('keeps a pending approval across $name and only acts on the explicit decision', async ({ stop, decision, managerCrash }) => {
    const directories = await createOpenCodeServeDirectories()
    const directory = join(directories.root, 'repo')
    const marker = join(directory, 'approved.txt')
    const command = `printf 'approved\\n' >> "${marker}"`
    const databasePath = join(directories.root, 'manager.db')
    let db = new Database(managerCrash ? databasePath : ':memory:')
    let requests = 0
    const llm = createServer((request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requests++
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          messages?: { role?: string; content?: unknown }[]
        }
        const last = body.messages?.at(-1)
        const result = last?.role === 'tool' && typeof last.content === 'string' ? toolResult.safeParse(parseJson(last.content)) : null
        const approved = existsSync(marker)
        const answered = approved || (result?.success === true && result.data.error !== undefined && result.data.error.type !== 'aborted')
        if (requests > 6) {
          response.writeHead(400).end('Fixture request budget exceeded')
          return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        const base = {
          id: `approval-${requests}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
        }
        const delta = answered
          ? { role: 'assistant', content: approved ? 'Approved once.' : 'Rejected.' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests}`,
                  type: 'function',
                  function: {
                    name: 'shell',
                    arguments: JSON.stringify({ command }),
                  },
                },
              ],
            }
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answered ? 'stop' : 'tool_calls' }] })}\n\n`,
        )
        response.end('data: [DONE]\n\n')
      })
    })
    let server: OpenCodeServe | undefined
    let client: FetchOpenCodeClient | undefined
    let sessionID: string | undefined
    let service: ScheduleService | undefined
    let jobId: number | undefined
    let runId: number | undefined
    let removeClient: (() => void) | undefined
    try {
      const listening = once(llm, 'listening')
      llm.listen(0, '0.0.0.0')
      await listening
      const address = llm.address()
      if (!address || typeof address === 'string') throw new Error('Fixture listener is unavailable')
      await mkdir(directory)
      await mkdir(join(directories.configHome, 'opencode'), {
        recursive: true,
      })
      await writeFile(
        join(directories.configHome, 'opencode', 'opencode.json'),
        JSON.stringify({
          autoupdate: false,
          providers: {
            mock: {
              package: '@opencode/ai/providers/openai-compatible',
              settings: {
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'fixture',
              },
              models: { fixture: { name: 'Fixture' } },
            },
          },
          model: 'mock/fixture',
          permissions: [{ action: '*', resource: '*', effect: 'ask' }],
        }),
      )
      server = await startOpenCodeServe({
        service: true,
        directories,
        env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
      })
      client = new FetchOpenCodeClient({
        baseUrl: server.baseUrl,
        basicAuth: buildOpenCodeBasicAuth(server.password),
        defaultDirectory: false,
      })
      let api = client.api
      const session = await api.session.create({
        title: 'Pending approval restart verification',
        location: { directory },
        model: { providerID: 'mock', id: 'fixture' },
      })
      sessionID = session.id
      migrate(db, allMigrations)
      db.prepare(
        `INSERT INTO repos (id, local_path, source_path, default_branch, clone_status, cloned_at) VALUES (1, 'approval-fixture', ?, 'main', 'ready', 1)`,
      ).run(directory)
      const job = createScheduleJob(
        db,
        1,
        buildCreateSchedulePersistenceInput({
          name: 'Approval restart verification',
          enabled: false,
          scheduleMode: 'interval',
          intervalMinutes: 60,
          prompt: 'Wait for shell approval',
          model: 'mock/fixture',
        }),
      )
      jobId = job.id
      const run = createScheduleRun(db, {
        repoId: 1,
        jobId: job.id,
        triggerSource: 'manual',
        status: 'running',
        startedAt: Date.now(),
        createdAt: Date.now(),
      })
      runId = run.id
      db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(session.id, run.id)
      await api.session.prompt({
        sessionID: session.id,
        text: `Use shell to run this command only after approval: ${command}`,
      })
      const pending = async () =>
        (await api.permission.list({ sessionID: session.id }, { signal: AbortSignal.timeout(5000) })).filter(
          (item) => item.action === 'shell',
        )
      await expect.poll(pending, { timeout: 15000 }).toHaveLength(1)
      expect(existsSync(marker)).toBe(false)
      expect(getScheduleRunById(db, 1, job.id, run.id)?.status).toBe('running')
      const previous = server
      await (stop === 'kill' ? previous.kill() : previous.terminate())
      server = undefined
      server = await startOpenCodeServe({
        service: true,
        directories,
        port: previous.port,
        password: previous.password,
        env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
      })
      if (managerCrash) {
        db.close()
        db = new Database(databasePath)
        client = new FetchOpenCodeClient({
          baseUrl: server.baseUrl,
          basicAuth: buildOpenCodeBasicAuth(server.password),
          defaultDirectory: false,
        })
        api = client.api
      }
      vi.spyOn(upstream, 'getOpenCodeUpstreamBaseUrl').mockReturnValue(server.baseUrl)
      sseAggregator.setPasswordResolver(() => previous.password)
      sseAggregator.setPendingActionsFetcher({ api })
      service = new ScheduleService(db, client, new ScheduleWorktreeManager(new GitAuthService(), db))
      sseAggregator.setScheduledSessionsResolver(() => service?.getActiveRunSessions() ?? [])
      sseAggregator.start()
      await service.recoverRunningRuns()
      expect(getScheduleRunById(db, 1, job.id, run.id)?.status).toBe('running')
      await expect.poll(pending, { timeout: 15000 }).toHaveLength(1)
      const current = (await pending())[0]
      if (!current) throw new Error('Pending shell approval disappeared')
      const observed: string[] = []
      removeClient = sseAggregator.addClient(
        'permission-resume-verification',
        (_event, data) => {
          const parsed = permissionEnvelope.safeParse(JSON.parse(data))
          if (
            parsed.success &&
            parsed.data.payload.data.sessionID === session.id &&
            parsed.data.payload.data.action === 'shell'
          )
            observed.push(parsed.data.payload.data.id)
        },
        () => {},
        [directory],
      )
      await expect.poll(() => observed, { timeout: 10000 }).toContain(current.id)
      expect(existsSync(marker)).toBe(false)
      expect(getScheduleRunById(db, 1, job.id, run.id)?.status).toBe('running')
      await api.permission.reply(
        { sessionID: session.id, requestID: current.id, decision },
        { signal: AbortSignal.timeout(5000) },
      )
      await api.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) })
      if (decision === 'once') {
        expect(await readFile(marker, 'utf8')).toBe('approved\n')
        await expect
          .poll(() => getScheduleRunById(db, 1, job.id, run.id), {
            timeout: 10000,
          })
          .toMatchObject({
            status: 'completed',
            responseText: 'Approved once.',
            usage: { error: null },
          })
      } else {
        await expect
          .poll(() => getScheduleRunById(db, 1, job.id, run.id), { timeout: 10000 })
          .toMatchObject({ status: 'failed', responseText: null })
        expect(getScheduleRunById(db, 1, job.id, run.id)?.errorText).toBe('The session execution was interrupted.')
        expect(existsSync(marker)).toBe(false)
      }
      expect(await pending()).toEqual([])
      expect(service.getActiveRunSessions()).toEqual([])
    } finally {
      try {
        if (
          service &&
          jobId !== undefined &&
          runId !== undefined &&
          getScheduleRunById(db, 1, jobId, runId)?.status === 'running'
        )
          await service.cancelRun(1, jobId, runId)
        if (client && sessionID && server) {
          await client.api.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5000) })
          await client.api.session.remove({ sessionID }, { signal: AbortSignal.timeout(5000) })
        }
      } finally {
        removeClient?.()
        sseAggregator.shutdown()
        sseAggregator.setPendingActionsFetcher(null)
        sseAggregator.setPasswordResolver(null)
        sseAggregator.setScheduledSessionsResolver(() => [])
        vi.restoreAllMocks()
        llm.closeAllConnections()
        await new Promise<void>((resolve, reject) => llm.close((error) => (error ? reject(error) : resolve())))
        await server?.terminate()
        db.close()
        await rm(directories.root, { recursive: true, force: true })
      }
    }
  }, 210000)
})
