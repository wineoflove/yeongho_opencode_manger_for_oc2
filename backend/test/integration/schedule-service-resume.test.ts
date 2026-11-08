import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildOpenCodeBasicAuth } from '@opencode-manager/shared/opencode'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { beginScheduleSubmission } from '../../src/db/schedule-submissions'
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
if (process.env.OPENCODE_BIN && binary !== process.env.OPENCODE_BIN) {
  throw new Error('The requested integration binary could not be resolved')
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out awaiting restart fixture event')), 15000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(binary === null)('scheduled session restart continuity', () => {
  it.each([
    { restarts: 1, throughService: false },
    { restarts: 2, throughService: false },
    { restarts: 1, throughService: true },
  ])(
    'keeps the run active after $restarts restart(s), service submission=$throughService, without duplication',
    async ({ restarts, throughService }) => {
      const directories = await createOpenCodeServeDirectories()
      const directory = join(directories.root, 'repo')
      const databasePath = join(directories.root, 'manager-fixture.db')
      let db = new Database(databasePath)
      let requestReceived = Promise.withResolvers<void>()
      const responses = new Set<ServerResponse>()
      const bodies: string[] = []
      const llm = createServer((request, response) => {
        if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
          response.writeHead(404).end()
          return
        }
        let body = ''
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          bodies.push(body)
          responses.add(response)
          response.on('close', () => responses.delete(response))
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          })
          response.write(
            `data: ${JSON.stringify({ id: 'resume', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
          )
          requestReceived.resolve()
        })
      })
      let server: OpenCodeServe | undefined
      let client: FetchOpenCodeClient | undefined
      let sessionID: string | undefined
      let service: ScheduleService | undefined
      let jobId: number | undefined
      let runId: number | undefined
      let unsubscribe: (() => void) | undefined
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
            permissions: [{ action: '*', resource: '*', effect: 'deny' }],
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
        const initialSession = throughService
          ? undefined
          : await client.api.session.create({
              title: 'Schedule restart verification',
              location: { directory },
              model: { providerID: 'mock', id: 'fixture' },
            })
        migrate(db, allMigrations)
        db.prepare(
          `INSERT INTO repos (id, local_path, source_path, default_branch, clone_status, cloned_at) VALUES (1, 'resume-fixture', ?, 'main', 'ready', 1)`,
        ).run(directory)
        const job = createScheduleJob(
          db,
          1,
          buildCreateSchedulePersistenceInput({
            name: 'Restart verification',
            enabled: false,
            scheduleMode: 'interval',
            intervalMinutes: 60,
            prompt: 'Return the verification result',
            model: 'mock/fixture',
          }),
        )
        jobId = job.id
        if (throughService)
          service = new ScheduleService(db, client, new ScheduleWorktreeManager(new GitAuthService(), db))
        const run = service
          ? await service.runJob(1, job.id, 'manual')
          : createScheduleRun(db, {
              repoId: 1,
              jobId: job.id,
              triggerSource: 'manual',
              status: 'running',
              startedAt: Date.now(),
              createdAt: Date.now(),
            })
        runId = run.id
        sessionID = initialSession?.id ?? run.sessionId ?? undefined
        if (!sessionID) throw new Error('Fixture did not create a session')
        const session = initialSession ?? (await client.api.session.get({ sessionID }))
        db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(session.id, run.id)
        let submissionID = 'msg_01j000000000000000000000000'
        if (throughService) {
          await expect
            .poll(() => db.prepare('SELECT state FROM schedule_run_submissions WHERE run_id = ?').get(run.id), {
              timeout: 15000,
            })
            .toEqual({ state: 'acknowledged' })
          submissionID = z
            .object({ message_id: z.string() })
            .parse(
              db.prepare('SELECT message_id FROM schedule_run_submissions WHERE run_id = ?').get(run.id),
            ).message_id
        } else {
          beginScheduleSubmission(db, {
            runId: run.id,
            sessionId: session.id,
            messageId: submissionID,
            createdAt: Date.now(),
          })
          const accepted = await client.api.session.prompt({
            sessionID: session.id,
            id: submissionID,
            text: 'Return the verification result without using tools.',
          })
          expect(accepted.id).toBe(submissionID)
        }
        await bounded(requestReceived.promise)
        expect(await client.api.session.active()).toHaveProperty(session.id)
        const password = server.password
        for (let restart = 0; restart < restarts; restart++) {
          requestReceived = Promise.withResolvers<void>()
          const previous = server
          await previous.terminate()
          server = undefined
          server = await startOpenCodeServe({
            service: true,
            directories,
            port: previous.port,
            password,
            env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
          })
          if (restart + 1 < restarts) await bounded(requestReceived.promise)
        }
        if (!throughService) {
          db.close()
          db = new Database(databasePath)
          expect(
            db.prepare('SELECT state, message_id FROM schedule_run_submissions WHERE run_id = ?').get(run.id),
          ).toEqual({
            state: 'pending',
            message_id: submissionID,
          })
        }
        vi.spyOn(upstream, 'getOpenCodeUpstreamBaseUrl').mockReturnValue(server.baseUrl)
        sseAggregator.setPasswordResolver(() => password)
        sseAggregator.setPendingActionsFetcher({ api: client.api })
        service = new ScheduleService(db, client, new ScheduleWorktreeManager(new GitAuthService(), db))
        sseAggregator.setScheduledSessionsResolver(() => service?.getActiveRunSessions() ?? [])
        const connected = Promise.withResolvers<void>()
        unsubscribe = sseAggregator.onUpstreamConnected(() => connected.resolve())
        sseAggregator.start()
        await service.recoverRunningRuns()
        await bounded(connected.promise)
        expect(getScheduleRunById(db, 1, job.id, run.id)?.status).toBe('running')
        await bounded(requestReceived.promise)
        expect(bodies).toHaveLength(restarts + 1)
        const retained = await client.api.message.list({
          sessionID: session.id,
        })
        expect(retained.data.filter((message) => message.id === submissionID)).toHaveLength(1)
        const checkpoint = new DatabaseSync(join(directories.dataHome, 'opencode', 'opencode.db'), { readOnly: true })
        try {
          expect(
            checkpoint.prepare('SELECT resume_attempts FROM session_v2 WHERE id = ?').get(session.id),
          ).toMatchObject({ resume_attempts: restarts })
        } finally {
          checkpoint.close()
        }
        for (const response of responses) {
          response.write(
            `data: ${JSON.stringify({ id: 'resume', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'Recovered once.' }, finish_reason: null }] })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ id: 'resume', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          )
          response.end('data: [DONE]\n\n')
        }
        await client.api.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) })
        await expect
          .poll(() => getScheduleRunById(db, 1, job.id, run.id), {
            timeout: 10000,
          })
          .toMatchObject({
            status: 'completed',
            responseText: 'Recovered once.',
            outcome: 'unreported',
            usage: { error: null, sessions: 1 },
          })
        expect(bodies).toHaveLength(restarts + 1)
        expect(service.getActiveRunSessions()).toEqual([])
        expect(db.prepare('SELECT state FROM schedule_run_submissions WHERE run_id = ?').get(run.id)).toEqual({
          state: 'acknowledged',
        })
        const settled = new DatabaseSync(join(directories.dataHome, 'opencode', 'opencode.db'), { readOnly: true })
        try {
          expect(
            settled.prepare('SELECT resume_attempts, time_suspended FROM session_v2 WHERE id = ?').get(session.id),
          ).toMatchObject({ resume_attempts: 0, time_suspended: null })
        } finally {
          settled.close()
        }
      } finally {
        try {
          if (
            service &&
            jobId !== undefined &&
            runId !== undefined &&
            getScheduleRunById(db, 1, jobId, runId)?.status === 'running'
          ) {
            await service.cancelRun(1, jobId, runId)
          }
          if (client && sessionID && server) {
            await client.api.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5000) })
            await client.api.session.remove({ sessionID }, { signal: AbortSignal.timeout(5000) })
          }
        } finally {
          unsubscribe?.()
          sseAggregator.shutdown()
          sseAggregator.setPendingActionsFetcher(null)
          sseAggregator.setPasswordResolver(null)
          sseAggregator.setScheduledSessionsResolver(() => [])
          vi.restoreAllMocks()
          for (const response of responses) response.destroy()
          llm.closeAllConnections()
          await new Promise<void>((resolve, reject) => llm.close((error) => (error ? reject(error) : resolve())))
          await server?.terminate()
          db.close()
          await rm(directories.root, { recursive: true, force: true })
        }
      }
    },
    210000,
  )
})
