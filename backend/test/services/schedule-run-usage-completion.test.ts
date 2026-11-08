import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { setImmediate } from 'node:timers/promises'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import * as schedulesDb from '../../src/db/schedules'
import { ScheduleService } from '../../src/services/schedules'
import { ScheduleWorktreeManager } from '../../src/services/schedule-worktree'
import { GitAuthService } from '../../src/services/git-auth'
import { OpenCodeServerRegistry } from '../../src/services/opencode-server-registry'
import { sseAggregator } from '../../src/services/sse-aggregator'
import * as modelResolver from '../../src/services/opencode-models'
import { createStubOpenCodeClient } from '../helpers/stub-opencode-client'
import { assistantMessage, createStubScheduleApi } from '../helpers/stub-schedule-api'

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const additionalUsage = {
  input: 7,
  output: 3,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 4,
  cost: 0.5,
}

describe('scheduled run usage at terminal teardown', () => {
  let db: Database
  let stub: ReturnType<typeof createStubScheduleApi>
  let service: ScheduleService
  let worktrees: ScheduleWorktreeManager

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    db.exec(`
      INSERT INTO repos (id, repo_url, local_path, branch, default_branch, clone_status, cloned_at)
      VALUES (1, 'https://example.com/repo', 'repos/usage', 'main', 'main', 'ready', 1);
      INSERT INTO schedule_jobs (id, repo_id, server_id, name, enabled, schedule_mode, interval_minutes, prompt, created_at, updated_at)
      VALUES (1, 1, 'local', 'Usage', 1, 'interval', 60, 'Review', 1, 1);
      INSERT INTO schedule_runs (id, job_id, repo_id, server_id, trigger_source, status, started_at, created_at, session_id, worktree_path)
      VALUES (1, 1, 1, 'local', 'manual', 'running', 1, 1, 'ses-run-1', '/tmp/usage-worktree');
    `)
    stub = createStubScheduleApi({
      sessionInfo: {
        id: 'ses-run-1',
        projectID: 'project-usage',
        title: 'Usage',
        location: { directory: '/tmp/usage-worktree' },
        time: { created: 1, updated: 2 },
        cost: 1.25,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 10 },
        },
      },
      messages: [assistantMessage('Finished', { completed: true })],
    })
    worktrees = new ScheduleWorktreeManager(new GitAuthService(), db)
    vi.spyOn(worktrees, 'finalize').mockResolvedValue({
      commitHash: 'commit-usage',
    })
    service = new ScheduleService(db, createStubOpenCodeClient({ api: stub.api }), worktrees)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    if (schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status === 'running') {
      stub.state.active = {}
      stub.state.activeError = undefined
      stub.state.interruptError = undefined
      await service.cancelRun(1, 1, 1)
    }
    vi.restoreAllMocks()
    db.close()
  })

  it('fails an overdue recovered execution only after interruption is confirmed and preserves its report', async () => {
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
      stub.state.active = {}
      return { interrupted: true }
    })
    service.reportOutcome(
      'ses-run-1',
      { outcome: 'partial', summary: 'Earlier work remains', additionalUsage },
      'reporter',
    )
    const report = schedulesDb.getScheduleRunById(db, 1, 1, 1)?.outcomeReport
    await service.recoverRunningRuns()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'failed',
      errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      outcome: 'partial',
      outcomeReport: report,
      usage: { additional: additionalUsage },
    })
    expect(stub.api.session.interrupt).toHaveBeenCalledOnce()
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(service.getActiveRunSessions()).toEqual([])
  })

  it.each(['request-failed', 'still-active'] as const)(
    'preserves an overdue run and its resources when interruption is %s',
    async (failure) => {
      stub.state.active = { 'ses-run-1': { type: 'running' } }
      if (failure === 'request-failed') stub.state.interruptError = new Error('private-remote-error')
      await service.recoverRunningRuns()
      const run = schedulesDb.getScheduleRunById(db, 1, 1, 1)
      expect(run).toMatchObject({
        status: 'running',
        finishedAt: null,
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
      expect(JSON.stringify(run)).not.toContain('private-remote-error')
      expect(worktrees.finalize).not.toHaveBeenCalled()
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
      expect(service.getActiveRunSessions().map((item) => item.sessionID)).toContain('ses-run-1')
      stub.state.active = {}
      sseAggregator.notifyServerConnected('local')
      await expect
        .poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 1), {
          timeout: 1000,
        })
        .toMatchObject({
          status: 'failed',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
          usage: { error: null },
        })
      expect(worktrees.finalize).toHaveBeenCalledOnce()
      expect(service.getActiveRunSessions()).toEqual([])
    },
  )

  it('continues observing after a failed status read without cleaning up an unconfirmed execution', async () => {
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    stub.state.interruptError = new Error('interrupt failed')
    await service.recoverRunningRuns()
    stub.state.activeError = new Error('private-status-error')
    sseAggregator.notifyServerConnected('local')
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
    expect(worktrees.finalize).not.toHaveBeenCalled()
    stub.state.activeError = undefined
    stub.state.active = {}
    sseAggregator.notifyServerConnected('local')
    await expect
      .poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 1), {
        timeout: 1000,
      })
      .toMatchObject({
        status: 'failed',
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(service.getActiveRunSessions()).toEqual([])
  })

  it('keeps a user cancellation authoritative while an expired monitor observes idle', async () => {
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    stub.state.interruptError = new Error('initial interruption failed')
    await service.recoverRunningRuns()
    const interrupted = Promise.withResolvers<{ interrupted: boolean }>()
    vi.mocked(stub.api.session.interrupt).mockReturnValueOnce(interrupted.promise)
    const cancellation = service.cancelRun(1, 1, 1)
    try {
      await setImmediate()
      stub.state.active = {}
      sseAggregator.notifyServerConnected('local')
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
      expect(worktrees.finalize).not.toHaveBeenCalled()
    } finally {
      interrupted.resolve({ interrupted: true })
      await cancellation
    }
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('cancelled')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(service.getActiveRunSessions()).toEqual([])
  })

  it('expires a recovered run at its original remaining deadline rather than granting a fresh budget', async () => {
    vi.useFakeTimers()
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 1').run(Date.now() - 120 * 60_000 + 1000)
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
      stub.state.active = {}
      return { interrupted: true }
    })
    await service.recoverRunningRuns()
    await vi.advanceTimersByTimeAsync(999)
    expect(stub.api.session.interrupt).not.toHaveBeenCalled()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(1)
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'failed',
      errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
    })
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['completed', 'cancelled'] as const)('clears a recovered deadline after the run is %s', async (status) => {
    vi.useFakeTimers()
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 1').run(Date.now() - 120 * 60_000 + 1000)
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    await service.recoverRunningRuns()
    await vi.advanceTimersByTimeAsync(0)
    if (status === 'cancelled') {
      vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
        stub.state.active = {}
        return { interrupted: true }
      })
      await service.cancelRun(1, 1, 1)
    } else {
      stub.state.active = {}
      sseAggregator.notifyServerConnected('local')
    }
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe(status), {
      timeout: 500,
      interval: 10,
    })
    const interrupts = vi.mocked(stub.api.session.interrupt).mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.mocked(stub.api.session.interrupt).mock.calls.length).toBe(interrupts)
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe(status)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([true, false])(
    'expires a newly submitted run while preserving resources until interruption is confirmed: %s',
    async (interrupted) => {
      vi.useFakeTimers()
      vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
        providerID: 'openai',
        id: 'gpt-fixture',
        model: 'openai/gpt-fixture',
      })
      stub.state.active = { 'ses-run-1': { type: 'running' } }
      vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
        if (interrupted) stub.state.active = {}
        return { interrupted }
      })
      const run = await service.runJob(1, 1, 'manual')
      schedulesDb.updateScheduleRunWorktree(db, 1, 1, run.id, {
        worktreePath: '/tmp/usage-worktree',
      })
      try {
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
        expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('running')
        expect(stub.api.session.interrupt).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)).toMatchObject({
          status: interrupted ? 'failed' : 'running',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
        })
        if (!interrupted) {
          expect(worktrees.finalize).not.toHaveBeenCalled()
          expect(service.getActiveRunSessions().map((item) => item.sessionID)).toContain('ses-run-1')
          stub.state.active = {}
          sseAggregator.notifyServerConnected('local')
          await vi.advanceTimersByTimeAsync(0)
          expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('failed')
        }
        expect(worktrees.finalize).toHaveBeenCalledOnce()
        expect(service.getActiveRunSessions()).toEqual([])
        expect(stub.api.session.interrupt).toHaveBeenCalledOnce()
        expect(stub.api.session.prompt).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        if (schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status === 'running') {
          await service.cancelRun(1, 1, run.id)
        }
      }
    },
  )

  it('waits for pending user cancellation before finalizing an expired interruption', async () => {
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    const expiredInterrupt = Promise.withResolvers<{ interrupted: boolean }>()
    const userInterrupt = Promise.withResolvers<{ interrupted: boolean }>()
    vi.mocked(stub.api.session.interrupt)
      .mockReturnValueOnce(expiredInterrupt.promise)
      .mockReturnValueOnce(userInterrupt.promise)
    const recovery = service.recoverRunningRuns()
    await vi.waitFor(() => expect(stub.api.session.interrupt).toHaveBeenCalledTimes(1))
    const cancellation = service.cancelRun(1, 1, 1)
    try {
      await vi.waitFor(() => expect(stub.api.session.interrupt).toHaveBeenCalledTimes(2))
      stub.state.active = {}
      expiredInterrupt.resolve({ interrupted: true })
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
      expect(worktrees.finalize).not.toHaveBeenCalled()
    } finally {
      expiredInterrupt.resolve({ interrupted: true })
      userInterrupt.resolve({ interrupted: true })
      await cancellation
      await recovery
    }
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('cancelled')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(service.getActiveRunSessions()).toEqual([])
  })

  it.each(['model', 'agent'] as const)(
    'expires %s lookup without creating a session when its response arrives late',
    async (stage) => {
      vi.useFakeTimers()
      vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
      const model = Promise.withResolvers<Awaited<ReturnType<typeof modelResolver.resolveOpenCodeModel>>>()
      const agents = Promise.withResolvers<Awaited<ReturnType<typeof stub.api.agent.list>>>()
      if (stage === 'agent') {
        db.prepare('UPDATE schedule_jobs SET agent_slug = ? WHERE id = 1').run('assistant')
        vi.mocked(stub.api.agent.list).mockReturnValueOnce(agents.promise)
      }
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockReturnValueOnce(model.promise)
      const request = service.runJob(1, 1, 'manual')
      const result = expect(request).rejects.toThrow('RUN_DEADLINE_EXCEEDED')
      try {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(service.listRuns(1, 1)[0]).toMatchObject({
          status: 'failed',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
        })
      } finally {
        agents.resolve({ location: { directory: '' }, data: [] })
        model.resolve({
          providerID: 'openai',
          id: 'gpt-fixture',
          model: 'openai/gpt-fixture',
        })
        try {
          await result
        } finally {
          await vi.advanceTimersByTimeAsync(0)
        }
      }
      expect(stub.api.session.create).not.toHaveBeenCalled()
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
      expect(service.getActiveRunSessions()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('retains an expired startup until its late worktree is available for cleanup', async () => {
    vi.useFakeTimers()
    vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    const prepared = Promise.withResolvers<Awaited<ReturnType<typeof worktrees.prepare>>>()
    vi.spyOn(worktrees, 'prepare').mockReturnValueOnce(prepared.promise)
    const result = expect(service.runJob(1, 1, 'manual')).rejects.toThrow('RUN_DEADLINE_EXCEEDED')
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(service.listRuns(1, 1)[0]).toMatchObject({
        status: 'running',
        finishedAt: null,
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
      expect(worktrees.finalize).not.toHaveBeenCalled()
      await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
    } finally {
      prepared.resolve({
        directory: '/tmp/usage-worktree',
        worktreePath: '/tmp/usage-worktree',
        runBranch: 'run-fixture',
      })
      await result
    }
    expect(service.listRuns(1, 1)[0]?.status).toBe('failed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(stub.api.session.create).not.toHaveBeenCalled()
    expect(stub.api.session.prompt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the late startup session in cancelled results and cleans its worktree once', async () => {
    vi.useFakeTimers()
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    vi.spyOn(worktrees, 'prepare').mockResolvedValue({
      directory: '/tmp/usage-worktree',
      worktreePath: '/tmp/usage-worktree',
      runBranch: 'run-fixture',
    })
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    const created = Promise.withResolvers<Awaited<ReturnType<typeof stub.api.session.create>>>()
    vi.mocked(stub.api.session.create).mockReturnValueOnce(created.promise)
    const startup = service.runJob(1, 1, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.api.session.create).toHaveBeenCalledOnce()
    const run = service.listRuns(1, 1)[0]
    if (!run) throw new Error('Startup fixture did not create a run')
    const cancellation = service.cancelRun(1, 1, run.id)
    const results = Promise.all([startup, cancellation])
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(service.listRuns(1, 1)[0]).toMatchObject({
        status: 'running',
        sessionId: null,
        finishedAt: null,
      })
      expect(worktrees.finalize).not.toHaveBeenCalled()
      await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
    } finally {
      created.resolve(await stub.api.session.get({ sessionID: 'ses-run-1' }))
      await results
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(await results).toEqual([
      expect.objectContaining({ status: 'cancelled', sessionId: 'ses-run-1' }),
      expect.objectContaining({ status: 'cancelled', sessionId: 'ses-run-1' }),
    ])
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(stub.api.session.prompt).not.toHaveBeenCalled()
    expect(service.getActiveRunSessions()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a session created after startup expiry without submitting a prompt', async () => {
    vi.useFakeTimers()
    vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    const created = Promise.withResolvers<Awaited<ReturnType<typeof stub.api.session.create>>>()
    vi.mocked(stub.api.session.create).mockReturnValueOnce(created.promise)
    const result = expect(service.runJob(1, 1, 'manual')).rejects.toThrow('RUN_DEADLINE_EXCEEDED')
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(service.listRuns(1, 1)[0]).toMatchObject({
        status: 'running',
        sessionId: null,
      })
      await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
    } finally {
      created.resolve(await stub.api.session.get({ sessionID: 'ses-run-1' }))
      await result
    }
    expect(service.listRuns(1, 1)[0]).toMatchObject({
      status: 'failed',
      sessionId: 'ses-run-1',
    })
    expect(stub.api.session.prompt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['acknowledged', 'rejected', 'mismatched'] as const)(
    'preserves an expired in-flight prompt until delivery is %s',
    async (delivery) => {
      vi.useFakeTimers()
      vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
        providerID: 'openai',
        id: 'gpt-fixture',
        model: 'openai/gpt-fixture',
      })
      const prompt = Promise.withResolvers<Awaited<ReturnType<typeof stub.api.session.prompt>>>()
      const acknowledgement: Awaited<ReturnType<typeof stub.api.session.prompt>> = {
        id: 'msg-fixture',
        sessionID: 'ses-run-1',
        time: { created: Date.now() },
        type: 'user',
        payload: { text: 'Review' },
        delivery: 'queue',
      }
      vi.mocked(stub.api.session.prompt).mockReturnValueOnce(prompt.promise)
      stub.state.active = { 'ses-run-1': { type: 'running' } }
      vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
        stub.state.active = {}
        return { interrupted: true }
      })
      const run = await service.runJob(1, 1, 'manual')
      schedulesDb.updateScheduleRunWorktree(db, 1, 1, run.id, {
        worktreePath: '/tmp/usage-worktree',
      })
      try {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(service.listRuns(1, 1)[0]).toMatchObject({
          status: 'running',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
        })
        expect(worktrees.finalize).not.toHaveBeenCalled()
        expect(stub.api.session.interrupt).not.toHaveBeenCalled()
        const submittedId = vi.mocked(stub.api.session.prompt).mock.calls[0]?.[0]?.id
        expect(submittedId).toEqual(expect.any(String))
        expect(
          db
            .prepare('SELECT message_id, state, acknowledged_at FROM schedule_run_submissions WHERE run_id = ?')
            .get(run.id),
        ).toEqual({
          message_id: submittedId,
          state: 'pending',
          acknowledged_at: null,
        })
        if (delivery === 'acknowledged') prompt.resolve({ ...acknowledgement, id: submittedId ?? 'invalid' })
        else if (delivery === 'mismatched') prompt.resolve(acknowledgement)
        else prompt.reject(new Error('private-delivery-error'))
        await vi.advanceTimersByTimeAsync(0)
        expect(db.prepare('SELECT state FROM schedule_run_submissions WHERE run_id = ?').get(run.id)).toEqual({
          state: delivery === 'acknowledged' ? 'acknowledged' : 'pending',
        })
        expect(service.listRuns(1, 1)[0]).toMatchObject({
          status: 'failed',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
        })
        expect(stub.api.session.interrupt).toHaveBeenCalledOnce()
        expect(stub.api.session.prompt).toHaveBeenCalledOnce()
        expect(worktrees.finalize).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        prompt.resolve(acknowledgement)
        await vi.advanceTimersByTimeAsync(0)
        if (service.listRuns(1, 1)[0]?.status === 'running') await service.cancelRun(1, 1, run.id)
        await vi.advanceTimersByTimeAsync(0)
      }
    },
  )

  it.each(['connected', 'rejected'] as const)(
    'does not create a session when expired MCP startup is %s',
    async (connection) => {
      vi.useFakeTimers()
      vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      db.prepare('UPDATE schedule_jobs SET mcp_servers = ? WHERE id = 1').run(JSON.stringify([{ name: 'fixture' }]))
      vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
        providerID: 'openai',
        id: 'gpt-fixture',
        model: 'openai/gpt-fixture',
      })
      stub.state.mcp.fixture = { status: 'pending' }
      const connected = Promise.withResolvers<void>()
      vi.mocked(stub.api.mcp.connect).mockImplementationOnce(async () => {
        await connected.promise
        stub.state.mcp.fixture = { status: 'connected' }
      })
      const result = expect(service.runJob(1, 1, 'manual')).rejects.toThrow('RUN_DEADLINE_EXCEEDED')
      try {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
        expect(service.listRuns(1, 1)[0]).toMatchObject({
          status: 'running',
          errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
        })
        expect(stub.api.session.create).not.toHaveBeenCalled()
      } finally {
        if (connection === 'connected') connected.resolve()
        else connected.reject(new Error('private-mcp-error'))
        await result
      }
      expect(service.listRuns(1, 1)[0]).toMatchObject({
        status: 'failed',
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
      expect(stub.api.session.create).not.toHaveBeenCalled()
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each([true, false])(
    'keeps resources after late prompt acceptance until interruption is confirmed: %s',
    async (interrupted) => {
      vi.useFakeTimers()
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
        providerID: 'openai',
        id: 'gpt-fixture',
        model: 'openai/gpt-fixture',
      })
      stub.state.messages = []
      const delivery = Promise.withResolvers<void>()
      vi.mocked(stub.api.session.prompt).mockImplementationOnce(async () => {
        await delivery.promise
        stub.state.active = { 'ses-run-1': { type: 'running' } }
        return {
          id: 'msg-late',
          sessionID: 'ses-run-1',
          time: { created: Date.now() },
          type: 'user',
          payload: { text: 'Review' },
          delivery: 'queue',
        }
      })
      vi.mocked(stub.api.session.interrupt).mockImplementation(async () => {
        if (interrupted) stub.state.active = {}
        return { interrupted }
      })
      const run = await service.runJob(1, 1, 'manual')
      schedulesDb.updateScheduleRunWorktree(db, 1, 1, run.id, {
        worktreePath: '/tmp/usage-worktree',
      })
      await vi.advanceTimersByTimeAsync(0)
      const cancelRequest = service.cancelRun(1, 1, run.id)
      const cancellation = interrupted
        ? cancelRequest
        : expect(cancelRequest).rejects.toThrow('CANCELLATION_UNCONFIRMED')
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(service.listRuns(1, 1)[0]?.status).toBe('running')
        expect(worktrees.finalize).not.toHaveBeenCalled()
        await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
      } finally {
        delivery.resolve()
        await cancellation
        await vi.advanceTimersByTimeAsync(0)
      }
      if (!interrupted) {
        expect(service.listRuns(1, 1)[0]?.status).toBe('running')
        expect(worktrees.finalize).not.toHaveBeenCalled()
        expect(service.getActiveRunSessions().map((item) => item.sessionID)).toContain('ses-run-1')
        stub.state.active = {}
        stub.state.messages = [
          assistantMessage('Completed after cancellation failed', {
            completed: true,
          }),
        ]
        sseAggregator.notifyServerConnected('local')
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(service.listRuns(1, 1)[0]?.status).toBe(interrupted ? 'cancelled' : 'completed')
      expect(stub.state.active).toEqual({})
      expect(stub.api.session.prompt).toHaveBeenCalledOnce()
      expect(worktrees.finalize).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not send a prompt when persisting its submission identity fails', async () => {
    vi.useFakeTimers()
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    db.exec(
      "CREATE TRIGGER reject_submission BEFORE INSERT ON schedule_run_submissions BEGIN SELECT RAISE(FAIL, 'write failed'); END",
    )
    vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    await service.runJob(1, 1, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.listRuns(1, 1)[0]?.status).toBe('failed')
    expect(stub.api.session.prompt).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM schedule_run_submissions').all()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not submit a prompt when skill lookup resolves after the run deadline', async () => {
    vi.useFakeTimers()
    vi.stubEnv('OCM_SCHEDULE_RUN_DEADLINE_MINUTES', '5')
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    db.prepare('UPDATE schedule_jobs SET skill_metadata = ? WHERE id = 1').run(
      JSON.stringify({ skillSlugs: ['review'] }),
    )
    vi.spyOn(worktrees, 'prepare').mockResolvedValue(null)
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    const skills = Promise.withResolvers<Awaited<ReturnType<typeof stub.api.skill.list>>>()
    vi.mocked(stub.api.skill.list).mockReturnValueOnce(skills.promise)
    const run = await service.runJob(1, 1, 'manual')
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)).toMatchObject({
        status: 'failed',
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
      skills.resolve({ location: { directory: '' }, data: [] })
      await vi.advanceTimersByTimeAsync(0)
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
      expect(service.getActiveRunSessions()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status === 'running') {
        await service.cancelRun(1, 1, run.id)
      }
      skills.resolve({ location: { directory: '' }, data: [] })
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it('retains resources when prompt delivery fails ambiguously and follows the accepted execution', async () => {
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    vi.spyOn(worktrees, 'prepare').mockResolvedValue({
      directory: '/tmp/usage-worktree',
      worktreePath: '/tmp/usage-worktree',
      runBranch: 'run-fixture',
    })
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    stub.state.messages = []
    vi.mocked(stub.api.session.prompt).mockImplementationOnce(async (input) => {
      stub.state.messages = [{ id: input.id ?? '', type: 'user', time: { created: 1 }, text: input.text }]
      stub.state.active = { 'ses-run-1': { type: 'running' } }
      throw new Error('socket hang up')
    })
    const run = await service.runJob(1, 1, 'manual')
    await expect.poll(() => stub.api.session.active).toHaveBeenCalled()
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('running')
    expect(worktrees.finalize).not.toHaveBeenCalled()
    expect(service.getActiveRunSessions().map((item) => item.sessionID)).toContain('ses-run-1')
    await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
    stub.state.active = {}
    stub.state.messages = [...stub.state.messages, assistantMessage('Accepted despite the lost response', { completed: true })]
    sseAggregator.notifyServerConnected('local')
    await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('completed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(stub.api.session.prompt).toHaveBeenCalledOnce()
    expect(service.getActiveRunSessions()).toEqual([])
  })

  it('retains a monitored run when its status read fails and resumes on the next signal', async () => {
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 1').run(Date.now())
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    await service.recoverRunningRuns()
    stub.state.activeError = new Error('private-status-error')
    sseAggregator.notifyServerConnected('local')
    await setImmediate()
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
    expect(worktrees.finalize).not.toHaveBeenCalled()
    expect(service.getActiveRunSessions().map((item) => item.sessionID)).toContain('ses-run-1')
    stub.state.activeError = undefined
    stub.state.active = {}
    sseAggregator.notifyServerConnected('local')
    await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('completed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(JSON.stringify(schedulesDb.getScheduleRunById(db, 1, 1, 1))).not.toContain('private-status-error')
  })

  it('retains a recovered run when its execution state cannot be read', async () => {
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 1').run(Date.now())
    stub.state.activeError = new Error('private-status-error')
    await service.recoverRunningRuns()
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('running')
    expect(worktrees.finalize).not.toHaveBeenCalled()
    stub.state.activeError = undefined
    sseAggregator.notifyServerConnected('local')
    await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('completed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
  })

  it('retains a recovered remote run while its server cannot be resolved and resumes once it can', async () => {
    db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('remote-retain', 'Remote', 'http://unused.invalid', 'opencode', 1, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'remote-retain', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET id = 103, repo_id = NULL, server_id = 'remote-retain', worktree_path = NULL WHERE id = 1;
    `)
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 103').run(Date.now())
    const client = createStubOpenCodeClient({ api: stub.api })
    const registry = new OpenCodeServerRegistry(db, client)
    const lookup = vi.spyOn(registry, 'getClient').mockImplementation(() => {
      throw new Error('registry unavailable')
    })
    service = new ScheduleService(db, client, worktrees, registry)
    try {
      await service.recoverRunningRuns()
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, null, 1, 103)).toMatchObject({ status: 'running', finishedAt: null })
      await expect(service.runServerJob('remote-retain', 1, 'manual')).rejects.toThrow('already running')
      sseAggregator.notifyServerConnected('remote-retain')
      await setImmediate()
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, null, 1, 103)?.status).toBe('running')
      lookup.mockReturnValue(client)
      sseAggregator.notifyServerConnected('remote-retain')
      await expect.poll(() => schedulesDb.getScheduleRunById(db, null, 1, 103)?.status).toBe('completed')
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
    } finally {
      lookup.mockReturnValue(client)
      if (schedulesDb.getScheduleRunById(db, null, 1, 103)?.status === 'running') {
        await service.cancelServerRun('remote-retain', 1, 103)
      }
    }
  })

  it('keeps retaining a run when its server becomes unresolvable during a recovery retry', async () => {
    db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('remote-retry', 'Remote', 'http://unused.invalid', 'opencode', 1, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'remote-retry', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET id = 104, repo_id = NULL, server_id = 'remote-retry', worktree_path = NULL WHERE id = 1;
    `)
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 104').run(Date.now())
    const client = createStubOpenCodeClient({ api: stub.api })
    const registry = new OpenCodeServerRegistry(db, client)
    const lookup = vi.spyOn(registry, 'getClient').mockReturnValue(client)
    service = new ScheduleService(db, client, worktrees, registry)
    stub.state.activeError = new Error('private-status-error')
    try {
      await service.recoverRunningRuns()
      await setImmediate()
      lookup.mockImplementation(() => {
        throw new Error('registry unavailable')
      })
      stub.state.activeError = undefined
      sseAggregator.notifyServerConnected('remote-retry')
      await setImmediate()
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, null, 1, 104)).toMatchObject({ status: 'running', finishedAt: null })
      await expect(service.runServerJob('remote-retry', 1, 'manual')).rejects.toThrow('already running')
      lookup.mockReturnValue(client)
      sseAggregator.notifyServerConnected('remote-retry')
      await expect.poll(() => schedulesDb.getScheduleRunById(db, null, 1, 104)?.status).toBe('completed')
    } finally {
      lookup.mockReturnValue(client)
      stub.state.activeError = undefined
      if (schedulesDb.getScheduleRunById(db, null, 1, 104)?.status === 'running') {
        await service.cancelServerRun('remote-retry', 1, 104)
      }
    }
  })

  it.each(['admitted', 'unobservable'] as const)(
    'retains the run when a typed prompt rejection arrives but admission is %s',
    async (observation) => {
      db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
      vi.spyOn(worktrees, 'prepare').mockResolvedValue({
        directory: '/tmp/usage-worktree',
        worktreePath: '/tmp/usage-worktree',
        runBranch: 'run-fixture',
      })
      vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
        providerID: 'openai',
        id: 'gpt-fixture',
        model: 'openai/gpt-fixture',
      })
      stub.state.messages = []
      let submittedId = ''
      vi.mocked(stub.api.session.prompt).mockImplementationOnce(async (input) => {
        submittedId = input.id ?? ''
        if (observation === 'admitted') {
          stub.state.messages = [{ id: input.id ?? '', type: 'user', time: { created: 1 }, text: input.text }]
          stub.state.active = { 'ses-run-1': { type: 'running' } }
        } else {
          stub.state.messageError = new Error('private-list-error')
        }
        throw Object.assign(new Error('Session not found after admission'), { _tag: 'SessionNotFoundError' })
      })
      const run = await service.runJob(1, 1, 'manual')
      await expect.poll(() => stub.api.message.list).toHaveBeenCalled()
      await setImmediate()
      expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('running')
      expect(worktrees.finalize).not.toHaveBeenCalled()
      await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
      stub.state.messageError = undefined
      stub.state.active = {}
      stub.state.messages = [
        { id: submittedId, type: 'user', time: { created: 1 }, text: 'Review' },
        assistantMessage('Settled after the error', { completed: true }),
      ]
      sseAggregator.notifyServerConnected('local')
      await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('completed')
      expect(worktrees.finalize).toHaveBeenCalledOnce()
      expect(stub.api.session.prompt).toHaveBeenCalledOnce()
    },
  )

  it('treats a prompt ID conflict as possibly accepted and retains the run', async () => {
    db.prepare('DELETE FROM schedule_runs WHERE id = 1').run()
    vi.spyOn(worktrees, 'prepare').mockResolvedValue({
      directory: '/tmp/usage-worktree',
      worktreePath: '/tmp/usage-worktree',
      runBranch: 'run-fixture',
    })
    vi.spyOn(modelResolver, 'resolveOpenCodeModel').mockResolvedValue({
      providerID: 'openai',
      id: 'gpt-fixture',
      model: 'openai/gpt-fixture',
    })
    stub.state.messages = []
    vi.mocked(stub.api.session.prompt).mockImplementationOnce(async (input) => {
      stub.state.messages = [{ id: input.id ?? '', type: 'user', time: { created: 1 }, text: input.text }]
      stub.state.active = { 'ses-run-1': { type: 'running' } }
      throw Object.assign(new Error('Prompt message ID conflicts with an existing durable record'), {
        _tag: 'ConflictError',
      })
    })
    const run = await service.runJob(1, 1, 'manual')
    await expect.poll(() => stub.api.session.active).toHaveBeenCalled()
    await setImmediate()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('running')
    expect(worktrees.finalize).not.toHaveBeenCalled()
    await expect(service.runJob(1, 1, 'manual')).rejects.toThrow('already running')
    stub.state.active = {}
    stub.state.messages = [...stub.state.messages, assistantMessage('Accepted before the conflict', { completed: true })]
    sseAggregator.notifyServerConnected('local')
    await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, run.id)?.status).toBe('completed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(stub.api.session.prompt).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive interruption without claiming the execution stopped', async () => {
    vi.useFakeTimers()
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    vi.mocked(stub.api.session.interrupt).mockReturnValue(new Promise(() => {}))
    const recovery = service.recoverRunningRuns()
    await vi.advanceTimersByTimeAsync(10_000)
    await recovery
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'running',
      finishedAt: null,
      errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
    })
    expect(worktrees.finalize).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    stub.state.active = {}
    await vi.advanceTimersByTimeAsync(30_000)
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.status).toBe('failed')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['completed', 'failed'] as const)(
    'persists lifetime totals and preserves the report when recovering %s',
    async (status) => {
      stub.state.messages = [
        assistantMessage('Finished', {
          completed: true,
          ...(status === 'failed' ? { error: 'provider failed' } : {}),
        }),
      ]
      service.reportOutcome('ses-run-1', { outcome: 'partial', summary: 'One remaining', additionalUsage }, 'reporter')
      const report = schedulesDb.getScheduleRunById(db, 1, 1, 1)?.outcomeReport

      await service.recoverRunningRuns()

      expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
        status,
        outcome: 'partial',
        outcomeReport: report,
        agentUsed: 'build',
        usage: {
          sessions: 1,
          error: null,
          additional: additionalUsage,
          totals: {
            input: 100,
            output: 20,
            reasoning: 5,
            cacheRead: 30,
            cacheWrite: 10,
            cost: 1.25,
            messages: 1,
          },
        },
        commitHash: 'commit-usage',
      })
    },
  )

  it('returns persisted usage after cancellation without replacing the reported outcome', async () => {
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    service.reportOutcome('ses-run-1', { outcome: 'blocked', summary: 'Waiting', additionalUsage }, null)

    const run = await service.cancelRun(1, 1, 1)

    expect(run).toMatchObject({
      status: 'cancelled',
      outcome: 'blocked',
      agentUsed: 'build',
      usage: { error: null, additional: additionalUsage },
    })
    expect(run.usage).toEqual(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.usage)
    expect(worktrees.finalize).toHaveBeenCalledOnce()
  })

  it('skips usage reads for a recovered run with no linked session', async () => {
    db.prepare('UPDATE schedule_runs SET session_id = NULL WHERE id = 1').run()

    await service.recoverRunningRuns()

    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'failed',
      usage: null,
    })
    expect(stub.api.session.get).not.toHaveBeenCalled()
    expect(worktrees.finalize).toHaveBeenCalledOnce()
  })

  it('persists a safe capture failure and still cleans up the completed run', async () => {
    stub.state.sessionError = new Error('secret-provider-response')

    await service.recoverRunningRuns()

    const run = schedulesDb.getScheduleRunById(db, 1, 1, 1)
    expect(run).toMatchObject({
      status: 'completed',
      responseText: 'Finished',
      commitHash: 'commit-usage',
    })
    expect(run?.usage?.error).toEqual(expect.any(String))
    expect(JSON.stringify(run?.usage)).not.toContain('secret-provider-response')
    expect(worktrees.finalize).toHaveBeenCalledOnce()
  })

  it('still cleans up and releases the run when usage persistence fails', async () => {
    db.exec(`CREATE TRIGGER reject_usage BEFORE UPDATE OF usage_json ON schedule_runs
      BEGIN SELECT RAISE(FAIL, 'usage write failed'); END`)

    await service.recoverRunningRuns()

    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'completed',
      usage: null,
      commitHash: 'commit-usage',
    })
    expect(worktrees.finalize).toHaveBeenCalledOnce()
    const next = schedulesDb.createScheduleRun(db, {
      jobId: 1,
      repoId: 1,
      triggerSource: 'manual',
      status: 'running',
      startedAt: 3,
      createdAt: 3,
    })
    await service.recoverRunningRuns()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, next.id)?.status).toBe('failed')
  })

  it('does not reread successful usage when a stale recovery snapshot causes a second teardown', async () => {
    const staleRuns = schedulesDb.listRunningScheduleRuns(db)
    vi.spyOn(schedulesDb, 'listRunningScheduleRuns').mockReturnValue(staleRuns)

    await service.recoverRunningRuns()
    await service.recoverRunningRuns()

    expect(stub.api.session.get).toHaveBeenCalledOnce()
    expect(stub.api.session.list).toHaveBeenCalledOnce()
    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)?.usage?.totals.cost).toBe(1.25)
  })

  it('captures from the linked server without reading the local server', async () => {
    db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('remote-usage', 'Remote', 'http://unused.invalid', 'opencode', 1, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'remote-usage', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET repo_id = NULL, server_id = 'remote-usage', worktree_path = NULL WHERE id = 1;
    `)
    const local = createStubScheduleApi()
    const localClient = createStubOpenCodeClient({ api: local.api })
    const registry = new OpenCodeServerRegistry(db, localClient)
    vi.spyOn(registry, 'getClient').mockReturnValue(createStubOpenCodeClient({ api: stub.api }))
    service = new ScheduleService(db, localClient, worktrees, registry)

    await service.recoverRunningRuns()

    expect(schedulesDb.getScheduleRunById(db, null, 1, 1)?.usage?.totals.cost).toBe(1.25)
    expect(local.api.session.get).not.toHaveBeenCalled()
  })

  it('keeps the existing remote execution observable when registry lookup fails at expiry', async () => {
    vi.useFakeTimers()
    db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('remote-usage', 'Remote', 'http://unused.invalid', 'opencode', 1, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'remote-usage', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET id = 101, repo_id = NULL, server_id = 'remote-usage', worktree_path = NULL WHERE id = 1;
    `)
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 101').run(Date.now() - 120 * 60_000 + 1000)
    stub.state.active = { 'ses-run-1': { type: 'running' } }
    const client = createStubOpenCodeClient({ api: stub.api })
    const registry = new OpenCodeServerRegistry(db, client)
    const lookup = vi.spyOn(registry, 'getClient').mockReturnValue(client)
    service = new ScheduleService(db, client, worktrees, registry)
    await service.recoverRunningRuns()
    lookup.mockImplementation(() => {
      throw new Error('registry unavailable')
    })
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(stub.api.session.interrupt).toHaveBeenCalledOnce()
      expect(schedulesDb.getScheduleRunById(db, null, 1, 101)).toMatchObject({
        status: 'running',
        errorText: expect.stringContaining('RUN_DEADLINE_EXCEEDED'),
      })
      lookup.mockReturnValue(client)
      stub.state.active = {}
      sseAggregator.notifyServerConnected('remote-usage')
      await vi.advanceTimersByTimeAsync(0)
      expect(schedulesDb.getScheduleRunById(db, null, 1, 101)?.status).toBe('failed')
      expect(service.getActiveRunSessions()).toEqual([])
    } finally {
      lookup.mockReturnValue(client)
      if (schedulesDb.getScheduleRunById(db, null, 1, 101)?.status === 'running') {
        stub.state.active = {}
        await service.cancelServerRun('remote-usage', 1, 101)
      }
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it.each(['pending', 'acknowledged'] as const)(
    'preserves a recovered %s submission until its message and execution are observed',
    async (state) => {
      db.prepare('UPDATE schedule_runs SET id = 201 WHERE id = 1').run()
      db.prepare("INSERT INTO schedule_run_submissions VALUES (201, 'ses-run-1', 'msg-pending', ?, 1, ?)").run(
        state,
        state === 'acknowledged' ? 2 : null,
      )
      stub.state.messages = []
      await service.recoverRunningRuns()
      try {
        await setImmediate()
        expect(schedulesDb.getScheduleRunById(db, 1, 1, 201)?.status).toBe('running')
        expect(worktrees.finalize).not.toHaveBeenCalled()
        expect(stub.api.session.prompt).not.toHaveBeenCalled()
        stub.state.messages = [
          {
            id: 'msg-pending',
            time: { created: 1 },
            text: 'Review',
            type: 'user',
          },
          assistantMessage('Recovered accepted submission', {
            completed: true,
          }),
        ]
        vi.mocked(stub.api.message.list)
          .mockResolvedValueOnce({
            data: [
              {
                id: 'msg-other',
                time: { created: 0 },
                text: 'Earlier',
                type: 'user',
              },
            ],
            cursor: { next: 'older-page' },
          })
          .mockResolvedValueOnce({
            data: [
              {
                id: 'msg-pending',
                time: { created: 1 },
                text: 'Review',
                type: 'user',
              },
            ],
            cursor: {},
          })
        sseAggregator.notifyServerConnected('local')
        await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 201)?.status).toBe('completed')
        expect(db.prepare('SELECT state FROM schedule_run_submissions WHERE run_id = 201').get()).toEqual({
          state: 'acknowledged',
        })
        expect(worktrees.finalize).toHaveBeenCalledOnce()
        expect(stub.api.session.prompt).not.toHaveBeenCalled()
      } finally {
        if (schedulesDb.getScheduleRunById(db, 1, 1, 201)?.status === 'running') await service.cancelRun(1, 1, 201)
        await setImmediate()
      }
    },
  )

  it('preserves pending resources when the message cursor repeats', async () => {
    db.prepare('UPDATE schedule_runs SET id = 202 WHERE id = 1').run()
    db.prepare(
      "INSERT INTO schedule_run_submissions VALUES (202, 'ses-run-1', 'msg-pending', 'pending', 1, NULL)",
    ).run()
    const page = {
      data: [
        {
          id: 'msg-other',
          type: 'user' as const,
          time: { created: 1 },
          text: 'Other',
        },
      ],
      cursor: { next: 'same' },
    }
    vi.mocked(stub.api.message.list).mockResolvedValueOnce(page).mockResolvedValueOnce(page)
    await service.recoverRunningRuns()
    try {
      await setImmediate()
      expect(stub.api.message.list).toHaveBeenCalledTimes(2)
      expect(stub.api.message.list).toHaveBeenNthCalledWith(
        2,
        {
          sessionID: 'ses-run-1',
          type: 'user',
          limit: 100,
          cursor: 'same',
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(schedulesDb.getScheduleRunById(db, 1, 1, 202)?.status).toBe('running')
      expect(worktrees.finalize).not.toHaveBeenCalled()
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
    } finally {
      stub.state.messages = [
        {
          id: 'msg-pending',
          type: 'user',
          time: { created: 1 },
          text: 'Review',
        },
        assistantMessage('Observed after cursor recovery', { completed: true }),
      ]
      sseAggregator.notifyServerConnected('local')
      await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 202)?.status).toBe('completed')
    }
  })

  it('observes a pending submission without SSE events and releases the polling timer on completion', async () => {
    vi.useFakeTimers()
    db.prepare('UPDATE schedule_runs SET id = 203 WHERE id = 1').run()
    db.prepare(
      "INSERT INTO schedule_run_submissions VALUES (203, 'ses-run-1', 'msg-pending', 'pending', 1, NULL)",
    ).run()
    stub.state.messages = []
    await service.recoverRunningRuns()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(schedulesDb.getScheduleRunById(db, 1, 1, 203)?.status).toBe('running')
      stub.state.messages = [
        {
          id: 'msg-pending',
          type: 'user',
          time: { created: 1 },
          text: 'Review',
        },
        assistantMessage('Finished without event', { completed: true }),
      ]
      await vi.advanceTimersByTimeAsync(30_000)
      expect(schedulesDb.getScheduleRunById(db, 1, 1, 203)?.status).toBe('completed')
      expect(worktrees.finalize).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (schedulesDb.getScheduleRunById(db, 1, 1, 203)?.status === 'running') await service.cancelRun(1, 1, 203)
      await vi.advanceTimersByTimeAsync(0)
    }
  })

  it.each(['pending', 'acknowledged'] as const)(
    'refuses destructive cancellation of a recovered %s submission before execution is observed',
    async (state) => {
      db.prepare('UPDATE schedule_runs SET id = 204 WHERE id = 1').run()
      db.prepare("INSERT INTO schedule_run_submissions VALUES (204, 'ses-run-1', 'msg-pending', ?, 1, ?)").run(
        state,
        state === 'acknowledged' ? 2 : null,
      )
      stub.state.messages = []
      await service.recoverRunningRuns()
      try {
        await expect(service.cancelRun(1, 1, 204)).rejects.toMatchObject({
          status: 409,
          message: expect.stringContaining('SUBMISSION_UNCONFIRMED'),
        })
        expect(schedulesDb.getScheduleRunById(db, 1, 1, 204)?.status).toBe('running')
        expect(worktrees.finalize).not.toHaveBeenCalled()
        expect(stub.api.session.interrupt).not.toHaveBeenCalled()
      } finally {
        stub.state.messages = [
          {
            id: 'msg-pending',
            type: 'user',
            time: { created: 1 },
            text: 'Review',
          },
          assistantMessage('Finally observed', { completed: true }),
        ]
        sseAggregator.notifyServerConnected('local')
        await expect.poll(() => schedulesDb.getScheduleRunById(db, 1, 1, 204)?.status).not.toBe('running')
      }
      expect(worktrees.finalize).toHaveBeenCalledOnce()
    },
  )

  it.each(['pending', 'acknowledged'] as const)(
    'preserves a %s remote submission when its server is unavailable',
    async (state) => {
      db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('disabled-usage', 'Disabled', 'http://unused.invalid', 'opencode', 0, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'disabled-usage', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET repo_id = NULL, server_id = 'disabled-usage', worktree_path = NULL WHERE id = 1;
    `)
      db.prepare("INSERT INTO schedule_run_submissions VALUES (1, 'ses-run-1', 'msg-pending', ?, 1, ?)").run(
        state,
        state === 'acknowledged' ? 2 : null,
      )
      const client = createStubOpenCodeClient({ api: stub.api })
      service = new ScheduleService(db, client, worktrees, new OpenCodeServerRegistry(db, client))
      await expect(service.cancelServerRun('disabled-usage', 1, 1)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('CANCELLATION_UNCONFIRMED'),
      })
      expect(schedulesDb.getScheduleRunById(db, null, 1, 1)?.status).toBe('running')
      expect(stub.api.session.interrupt).not.toHaveBeenCalled()
      expect(worktrees.finalize).not.toHaveBeenCalled()
    },
  )

  it('refuses offline cancellation of a recovered linked run without submission metadata until its server returns', async () => {
    db.exec(`
      INSERT INTO opencode_servers (id, name, base_url, username, enabled, created_at, updated_at)
      VALUES ('disabled-usage', 'Disabled', 'http://unused.invalid', 'opencode', 0, 1, 1);
      UPDATE schedule_jobs SET repo_id = NULL, server_id = 'disabled-usage', directory = '/remote', workspace_mode = 'in-place' WHERE id = 1;
      UPDATE schedule_runs SET repo_id = NULL, server_id = 'disabled-usage', worktree_path = NULL WHERE id = 1;
    `)
    db.prepare('UPDATE schedule_runs SET started_at = ? WHERE id = 1').run(Date.now())
    const client = createStubOpenCodeClient({ api: stub.api })
    const registry = new OpenCodeServerRegistry(db, client)
    vi.spyOn(registry, 'getClient').mockReturnValue(client)
    service = new ScheduleService(db, client, worktrees, registry)
    try {
      await service.recoverRunningRuns()
      await setImmediate()
      await expect(service.cancelServerRun('disabled-usage', 1, 1)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('CANCELLATION_UNCONFIRMED'),
      })
      expect(schedulesDb.getScheduleRunById(db, null, 1, 1)).toMatchObject({ status: 'running', finishedAt: null })
      expect(stub.api.session.interrupt).not.toHaveBeenCalled()
      expect(stub.api.session.get).not.toHaveBeenCalled()
      db.prepare("UPDATE opencode_servers SET enabled = 1 WHERE id = 'disabled-usage'").run()
      await expect(service.runServerJob('disabled-usage', 1, 'manual')).rejects.toThrow('already running')
      expect(worktrees.finalize).not.toHaveBeenCalled()
      sseAggregator.notifyServerConnected('disabled-usage')
      await expect.poll(() => schedulesDb.getScheduleRunById(db, null, 1, 1)?.status).toBe('completed')
      expect(stub.api.session.prompt).not.toHaveBeenCalled()
    } finally {
      db.prepare("UPDATE opencode_servers SET enabled = 1 WHERE id = 'disabled-usage'").run()
      if (schedulesDb.getScheduleRunById(db, null, 1, 1)?.status === 'running') {
        stub.state.active = {}
        await service.cancelServerRun('disabled-usage', 1, 1)
      }
    }
  })

  it('keeps captured usage when worktree finalization fails', async () => {
    vi.mocked(worktrees.finalize).mockRejectedValue(new Error('worktree cleanup failed'))

    await service.recoverRunningRuns()

    expect(schedulesDb.getScheduleRunById(db, 1, 1, 1)).toMatchObject({
      status: 'completed',
      usage: { error: null, totals: { cost: 1.25 } },
    })
  })
})
