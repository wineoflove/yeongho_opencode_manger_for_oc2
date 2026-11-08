import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  beginScheduleSubmission,
  acknowledgeScheduleSubmission,
  getScheduleSubmission,
} from '../db/schedule-submissions'
import path from 'path'
import type { Database } from 'bun:sqlite'
import { Cron } from 'croner'
import {
  type CreateScheduleJobRequest,
  type ScheduleJob,
  type ScheduleRun,
  type ScheduleRunTriggerSource,
  type ScheduleRunWorktreesMode,
  type ScheduleSandboxConfig,
  type ScheduleWorkspaceMode,
  type ScheduleWorktree,
  type UpdateScheduleJobRequest,
} from '@opencode-manager/shared/types'
import { mcpStatusByName, openCodeErrorStatus, openCodeLocation } from '@opencode-manager/shared/opencode'
import {
  LOCAL_OPENCODE_SERVER_ID,
  buildSchedulePermissionRuleset,
  type ScheduleOutcomeReportInput,
  type ScheduleRunOutcome,
} from '@opencode-manager/shared/schemas'
import { getRepoById } from '../db/queries'
import { getSessionSandboxMode } from '../db/session-sandbox-modes'
import type { ScheduleJobWithRepo } from '../db/schedules'
import {
  cleanupOrphanedSchedules,
  clearScheduleRunWorktreePath,
  createScheduleJob,
  createScheduleRun,
  deleteScheduleJob,
  deleteScheduleRunById,
  deleteScheduleRunsByIds,
  getScheduleJobById,
  getRunningScheduleRunByJob,
  getRunningScheduleRunBySessionId,
  getScheduleRunById,
  listAllScheduleJobsWithRepos,
  listScheduleRunArtifactsByJob,
  listAllScheduleRuns,
  listUnreadScheduleRuns,
  countUnreadScheduleRuns,
  markScheduleRunViewed,
  markAllScheduleRunsViewed,
  listEnabledScheduleJobs,
  listScheduleJobIdsByRepo,
  listScheduleJobsByRepo,
  listScheduleJobsByServer,
  listRunningScheduleRuns,
  listScheduleRunsByJob,
  updateScheduleJob,
  updateScheduleJobRunState,
  updateScheduleRun,
  updateScheduleRunMetadata,
  updateScheduleRunOutcomeReport,
  updateScheduleRunUsage,
  updateScheduleRunWorktree,
} from '../db/schedules'
import type { ListAllRunsOptions, ScheduleRunWithContext, ScheduleRunWithUnreadPreview } from '../db/schedules'
import {
  buildCreateSchedulePersistenceInput,
  buildUpdatedSchedulePersistenceInput,
  computeNextRunAtForJob,
} from './schedule-config'
import { resolveOpenCodeModel } from './opencode-models'
import { buildFailedUsage, captureScheduleRunUsage } from './schedule-run-usage'
import {
  buildRunDeadlineErrorText,
  getRunDeadlineMs,
  RunDeadline,
  RunDeadlineAbortError,
} from './schedule-run-deadline'
import { isSessionBusy, readLatestAssistantReply, sessionSettleSignal, type AssistantReplyState } from './session-reply'
import type { OpenCodeClient } from './opencode/client'
import type { OpenCodeServerRegistry } from './opencode-server-registry'
import type { ScheduleWorktreeManager } from './schedule-worktree'
import type { Repo } from '../types/repo'
import { sseAggregator, type ScheduledSessionRef } from './sse-aggregator'
import { getErrorMessage } from '../utils/error-utils'
import { logger } from '../utils/logger'
import { canonicalPathSync } from '../utils/fs-safe'
import { buildAssistantRepo } from './assistant-mode'
import { createScheduleWorktreeDescriber } from './schedule-worktree-paths'
import { SessionSandboxError, type SessionSandboxService } from './session-sandbox'
import type { SandboxRuntimeService } from './sandbox/runtime'
import { ASSISTANT_REPO_ID } from '@opencode-manager/shared/utils'

class ScheduleServiceError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

class ServerUnavailableError extends ScheduleServiceError {}

const SESSION_STOPPED_ERROR =
  'The session stopped without producing an assistant response. This usually means OpenCode restarted mid-run or the session was interrupted. Open the linked session to inspect any partial output and rerun if needed.'

const DELETION_RESERVATION_RUN_ID = -1

interface SessionSignal {
  errorText: string | null
  disposed: boolean
}

interface SessionMonitor {
  markSubmitted(): void
  nextSignal(timeoutMs?: number): Promise<SessionSignal>
  dispose(): void
}

interface ActiveRun {
  runId: number
  abort: AbortController
  sessionMonitor?: SessionMonitor
  pendingSubmission?: Promise<void>
  pendingStartup?: { promise: Promise<void>; resolve: () => void }
  startupCancellation?: boolean
  /** Reloaded after a restart, so this process has no evidence of what the run already submitted. */
  recovered?: boolean
}

type CancelDecision = 'cancelled' | 'settled' | 'resume'

interface PendingCancel {
  runId: number
  decision: Promise<CancelDecision>
  resolve: (decision: CancelDecision) => void
  resolved: boolean
}

type AssistantOutcome =
  | { kind: 'busy' }
  | { kind: 'settled'; responseText: string | null; errorText: string | null }
  | { kind: 'stopped'; responseText: string | null }

function buildSessionTitle(job: ScheduleJob): string {
  return `Scheduled: ${job.name}`
}

type SkillAttachment = { id: string }

function buildRunLog(input: {
  job: ScheduleJob
  triggerSource: ScheduleRunTriggerSource
  sessionId?: string | null
  sessionTitle?: string | null
  responseText?: string | null
  errorText?: string | null
  finishedAt: number
}): string {
  const scheduleLabel =
    input.job.scheduleMode === 'cron'
      ? `${input.job.cronExpression ?? ''} (${input.job.timezone ?? 'UTC'})`
      : `every ${input.job.intervalMinutes ?? 0} minutes`

  const lines = [
    `Job: ${input.job.name}`,
    `Trigger: ${input.triggerSource}`,
    `Finished: ${new Date(input.finishedAt).toISOString()}`,
    `Agent: ${input.job.agentSlug ?? 'default'}`,
    `Schedule: ${scheduleLabel}`,
  ]

  if (input.sessionId) {
    lines.push(`Session ID: ${input.sessionId}`)
  }

  if (input.sessionTitle) {
    lines.push(`Session title: ${input.sessionTitle}`)
  }

  if (input.errorText) {
    lines.push('', 'Error:', input.errorText)
  }

  if (input.responseText) {
    lines.push('', 'Assistant output:', input.responseText)
  }

  return lines.join('\n')
}

function buildRunStartedLog(input: {
  job: ScheduleJob
  triggerSource: ScheduleRunTriggerSource
  sessionId: string
  sessionTitle: string
}): string {
  const scheduleLabel =
    input.job.scheduleMode === 'cron'
      ? `${input.job.cronExpression ?? ''} (${input.job.timezone ?? 'UTC'})`
      : `every ${input.job.intervalMinutes ?? 0} minutes`

  return [
    `Job: ${input.job.name}`,
    `Trigger: ${input.triggerSource}`,
    `Started: ${new Date().toISOString()}`,
    `Agent: ${input.job.agentSlug ?? 'default'}`,
    `Schedule: ${scheduleLabel}`,
    `Session ID: ${input.sessionId}`,
    `Session title: ${input.sessionTitle}`,
    '',
    'Run started. Waiting for assistant response...',
  ].join('\n')
}

function createSessionMonitor(
  directory: string,
  sessionId: string,
  serverId: string = LOCAL_OPENCODE_SERVER_ID,
): SessionMonitor {
  const queued: SessionSignal[] = []
  let waiting: ((signal: SessionSignal) => void) | null = null
  let disposed = false

  const push = (signal: SessionSignal): void => {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(signal)
      return
    }
    queued.push(signal)
  }

  const handleEvent = (event: Parameters<typeof sessionSettleSignal>[0]): void => {
    const signal = sessionSettleSignal(event, sessionId)
    if (signal) {
      push({ errorText: signal.errorText, disposed: false })
    }
  }

  const unsubscribe =
    serverId === LOCAL_OPENCODE_SERVER_ID
      ? sseAggregator.onEvent((eventDirectory, event) => {
          if (eventDirectory !== directory) {
            return
          }
          handleEvent(event)
        })
      : sseAggregator.onServerEvent((eventServerId, eventDirectory, event) => {
          if (eventServerId !== serverId) {
            return
          }
          if (eventDirectory !== null && eventDirectory !== directory) {
            return
          }
          handleEvent(event)
        })

  const unsubscribeConnected = sseAggregator.onServerConnected((connectedServerId) => {
    if (connectedServerId === serverId) {
      push({ errorText: null, disposed: false })
    }
  })

  return {
    markSubmitted: () => {
      queued.length = 0
    },
    nextSignal: (timeoutMs) => {
      const next = queued.shift()
      if (next) {
        return Promise.resolve(next)
      }
      if (disposed) {
        return Promise.resolve({ errorText: null, disposed: true })
      }
      return new Promise<SessionSignal>((resolve) => {
        const timer =
          timeoutMs === undefined ? undefined : setTimeout(() => push({ errorText: null, disposed: false }), timeoutMs)
        waiting = (signal) => {
          clearTimeout(timer)
          resolve(signal)
        }
      })
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      unsubscribe()
      unsubscribeConnected()
      push({ errorText: null, disposed: true })
    },
  }
}

const PROMPT_REJECTION_TAGS = new Set([
  'InvalidRequestError',
  'SessionNotFoundError',
  'UnauthorizedError',
  'ForbiddenError',
])

/**
 * OpenCode's prompt handler raises these typed errors before admitting a prompt. Conflicts mean the
 * message ID already exists and may have been accepted, so they and transport or server errors leave
 * delivery unknown.
 */
function isDefinitePromptRejection(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const { _tag: tag, name } = error as { _tag?: unknown; name?: unknown }
  const label = typeof tag === 'string' ? tag : name
  return typeof label === 'string' && PROMPT_REJECTION_TAGS.has(label) && openCodeErrorStatus(error) !== undefined
}

export type ScheduleJobTarget =
  { kind: 'repo'; repoId: number } | { kind: 'server'; serverId: string; directory: string }

interface ScheduleTargetContext {
  repo: Repo | null
  client: OpenCodeClient
  directory: string
  repoId: number | null
  serverId: string
}

export interface ScheduleSandboxDependencies {
  sessions: Pick<SessionSandboxService, 'assertSandboxRequestAllowed' | 'update' | 'resolveShellTarget'>
  runtime: Pick<SandboxRuntimeService, 'planShell' | 'removeSessionSandbox'>
}

export class ScheduleService {
  private static activeRuns = new Map<number, ActiveRun>()
  private static pendingCancels = new Map<number, PendingCancel>()
  private static activeTeardowns = new Set<string>()
  private onJobChange: ((job: ScheduleJob | null, jobId: number) => void) | null = null
  private onWorktreeRemoved: ((directory: string) => Promise<void>) | null = null

  constructor(
    private readonly db: Database,
    private readonly openCodeClient: OpenCodeClient,
    private readonly worktreeManager: ScheduleWorktreeManager,
    private readonly serverRegistry: OpenCodeServerRegistry | null = null,
    private readonly sandbox: ScheduleSandboxDependencies | null = null,
  ) {}

  setJobChangeHandler(handler: ((job: ScheduleJob | null, jobId: number) => void) | null): void {
    this.onJobChange = handler
  }

  setWorktreeRemovedHandler(handler: ((directory: string) => Promise<void>) | null): void {
    this.onWorktreeRemoved = handler
  }

  private static abortActiveRun(jobId: number, runId: number): void {
    const active = ScheduleService.activeRuns.get(jobId)
    if (active?.runId === runId) {
      active.abort.abort()
    }
  }

  private static requestCancel(jobId: number, runId: number): Promise<CancelDecision> {
    const existing = ScheduleService.pendingCancels.get(jobId)

    if (existing?.runId === runId && !existing.resolved) {
      throw new ScheduleServiceError('Schedule run cancellation is already in progress', 409)
    }

    if (existing) {
      existing.resolved = true
      existing.resolve('resume')
    }

    let resolve!: (decision: CancelDecision) => void
    const decision = new Promise<CancelDecision>((r) => {
      resolve = r
    })
    ScheduleService.pendingCancels.set(jobId, {
      runId,
      decision,
      resolve,
      resolved: false,
    })
    return decision
  }

  private static settleCancel(jobId: number, runId: number, status: ScheduleRun['status'] | undefined): void {
    const decision: CancelDecision =
      status === 'cancelled' ? 'cancelled' : status === 'completed' || status === 'failed' ? 'settled' : 'resume'
    ScheduleService.resolveCancel(jobId, runId, decision)
  }

  private static resolveCancel(jobId: number, runId: number, decision: CancelDecision): void {
    const pending = ScheduleService.pendingCancels.get(jobId)
    if (pending?.runId !== runId || pending.resolved) {
      return
    }

    pending.resolved = true
    pending.resolve(decision)
  }

  private static awaitCancelDecision(jobId: number, runId: number): Promise<CancelDecision> {
    const pending = ScheduleService.pendingCancels.get(jobId)
    return pending?.runId === runId ? pending.decision : Promise.resolve('resume')
  }

  private static clearCancel(jobId: number, runId: number): void {
    if (ScheduleService.pendingCancels.get(jobId)?.runId !== runId) {
      return
    }

    ScheduleService.pendingCancels.delete(jobId)
  }

  private static releaseActiveRun(jobId: number, runId: number): void {
    if (ScheduleService.activeRuns.get(jobId)?.runId === runId) {
      ScheduleService.activeRuns.delete(jobId)
    }
  }

  private static attachSessionMonitor(jobId: number, runId: number, sessionMonitor: SessionMonitor): void {
    const active = ScheduleService.activeRuns.get(jobId)
    if (active?.runId === runId) {
      active.sessionMonitor = sessionMonitor
    }
  }

  private static disposeActiveRunMonitor(jobId: number, runId: number): void {
    const active = ScheduleService.activeRuns.get(jobId)
    if (active?.runId !== runId || !active.sessionMonitor) {
      return
    }
    active.sessionMonitor.dispose()
    active.sessionMonitor = undefined
  }

  getActiveRunSessions(): ScheduledSessionRef[] {
    const refs: ScheduledSessionRef[] = []

    for (const run of listRunningScheduleRuns(this.db)) {
      if (!run.sessionId) continue
      if (run.repoId === null) continue

      const directory = run.worktreePath ?? this.findRepoPath(run.repoId)
      if (!directory) continue

      refs.push({ sessionID: run.sessionId, directory })
    }

    return refs
  }

  private findRepoPath(repoId: number): string | null {
    try {
      return this.assertRepo(repoId).fullPath
    } catch {
      return null
    }
  }

  private assertServer(serverId: string) {
    const server = this.serverRegistry?.get(serverId)
    if (!server) {
      throw new ServerUnavailableError('OpenCode server not found', 404)
    }
    if (!server.enabled) {
      throw new ServerUnavailableError(`OpenCode server "${server.name}" is disabled`, 400)
    }
    return server
  }

  private safeServerClient(serverId: string): OpenCodeClient {
    try {
      return this.serverClient(serverId)
    } catch {
      return this.openCodeClient
    }
  }

  private serverClient(serverId: string): OpenCodeClient {
    if (!this.serverRegistry) {
      throw new ScheduleServiceError('Linked OpenCode servers are not available', 500)
    }
    try {
      return this.serverRegistry.getClient(serverId)
    } catch (error) {
      throw new ScheduleServiceError(getErrorMessage(error) || 'OpenCode server is not available', 400)
    }
  }

  private resolveTargetContext(target: ScheduleJobTarget, directory?: string | null): ScheduleTargetContext {
    if (target.kind === 'repo') {
      const repo = this.assertRepo(target.repoId)
      return {
        repo,
        client: this.openCodeClient,
        directory: repo.fullPath,
        repoId: target.repoId,
        serverId: LOCAL_OPENCODE_SERVER_ID,
      }
    }

    this.assertServer(target.serverId)
    const resolvedDirectory = directory ?? target.directory
    if (!resolvedDirectory) {
      throw new ScheduleServiceError('A remote schedule requires an absolute target directory', 400)
    }
    return {
      repo: null,
      client: this.serverClient(target.serverId),
      directory: resolvedDirectory,
      repoId: null,
      serverId: target.serverId,
    }
  }

  private resolveTargetPersistence(target: ScheduleJobTarget): {
    repo: Repo | null
    repoId: number | null
  } {
    if (target.kind === 'repo') {
      return { repo: this.assertRepo(target.repoId), repoId: target.repoId }
    }
    return { repo: null, repoId: null }
  }

  private targetForJob(job: ScheduleJob): ScheduleJobTarget {
    if (job.repoId !== null) {
      return { kind: 'repo', repoId: job.repoId }
    }
    return {
      kind: 'server',
      serverId: job.serverId ?? LOCAL_OPENCODE_SERVER_ID,
      directory: job.directory ?? '',
    }
  }

  private loadJobForTarget(target: ScheduleJobTarget, jobId: number): ScheduleJob {
    const job = getScheduleJobById(this.db, target.kind === 'repo' ? target.repoId : null, jobId)
    if (!job) {
      throw new ScheduleServiceError('Schedule not found', 404)
    }
    if (target.kind === 'server' && (job.serverId ?? LOCAL_OPENCODE_SERVER_ID) !== target.serverId) {
      throw new ScheduleServiceError('Schedule not found', 404)
    }
    return job
  }

  private assertInPlaceWorkspace(target: ScheduleJobTarget, workspaceMode: ScheduleWorkspaceMode | undefined): void {
    if (target.kind === 'server') {
      if (workspaceMode !== undefined && workspaceMode !== 'in-place') {
        throw new ScheduleServiceError(
          'Schedules on a linked server run in place; worktree workspace modes are only available for local repositories.',
          400,
        )
      }
      return
    }
    if (workspaceMode === 'in-place') {
      throw new ScheduleServiceError('In-place workspace mode is only available for schedules on a linked server.', 400)
    }
  }

  private assertSandboxJobSupported(serverId: string, sandbox: ScheduleSandboxConfig | null | undefined): void {
    if (sandbox?.enabled !== true) return

    if (serverId !== LOCAL_OPENCODE_SERVER_ID) {
      throw new ScheduleServiceError('Sandboxed schedules run only on the local OpenCode server.', 400)
    }

    const dependencies = this.sandbox
    if (!dependencies) {
      throw new ScheduleServiceError('Sandboxing is not available for schedules.', 409)
    }

    try {
      dependencies.sessions.assertSandboxRequestAllowed({
        sandboxed: true,
        resources: sandbox.resources,
      })
    } catch (error) {
      if (error instanceof SessionSandboxError) {
        throw new ScheduleServiceError(error.message, error.status)
      }
      throw error
    }
  }

  private async startRunSandbox(directory: string, sandbox: ScheduleSandboxConfig, sessionId: string): Promise<void> {
    const dependencies = this.sandbox
    if (!dependencies) {
      throw new ScheduleServiceError('Sandboxing is not available for schedules.', 409)
    }

    await dependencies.sessions.update(sessionId, {
      sandboxed: true,
      resources: sandbox.resources,
    })
    const target = await dependencies.sessions.resolveShellTarget(sessionId)
    const plan = await dependencies.runtime.planShell(directory, { ...target, locationDirectory: directory }, true)

    if (plan.mode !== 'sandbox') {
      const reason = plan.mode === 'blocked' ? plan.reason : 'the shell plan was not sandboxed'
      throw new ScheduleServiceError(`Sandbox could not start: ${reason}`, 502)
    }
  }

  listAllEnabledJobs(): ScheduleJob[] {
    return listEnabledScheduleJobs(this.db)
  }

  listAllJobsWithRepos(): Array<ScheduleJobWithRepo & { retainedWorktreeCount: number }> {
    const describeSchedule = createScheduleWorktreeDescriber(this.db)
    const counts = new Map<number, number>()
    for (const entry of this.worktreeManager.listWorktrees()) {
      const described = describeSchedule(canonicalPathSync(path.resolve(entry.worktreePath)))
      if (described?.inUse === false) {
        counts.set(entry.jobId, (counts.get(entry.jobId) ?? 0) + 1)
      }
    }
    return listAllScheduleJobsWithRepos(this.db).map((job) => ({
      ...job,
      retainedWorktreeCount: counts.get(job.id) ?? 0,
    }))
  }

  /**
   * Lists the worktrees of a schedule that still exist on disk: kept run worktrees,
   * the shared worktree, and the worktree of a run in progress.
   */
  listWorktrees(repoId: number, jobId: number): ScheduleWorktree[] {
    this.assertJob(repoId, jobId)
    const describeSchedule = createScheduleWorktreeDescriber(this.db)

    return this.worktreeManager
      .listWorktrees(jobId)
      .map((entry) => {
        const described = describeSchedule(canonicalPathSync(path.resolve(entry.worktreePath)))
        return {
          worktreePath: entry.worktreePath,
          branch: entry.branch,
          runId: entry.runId,
          inUse: described?.inUse ?? false,
        }
      })
      .sort((left, right) => (right.runId ?? Number.MAX_SAFE_INTEGER) - (left.runId ?? Number.MAX_SAFE_INTEGER))
  }

  /**
   * Removes one of a schedule's worktrees, or every worktree not in use when no path is
   * given. Pending changes are committed to each worktree's branch first and branches are
   * kept, so a shared schedule continues from its branch on the next run.
   */
  async removeWorktrees(repoId: number, jobId: number, worktreePath?: string): Promise<{ removed: number }> {
    const repo = this.assertRepo(repoId)
    const job = this.assertJob(repoId, jobId)
    const worktrees = this.listWorktrees(repoId, jobId)

    let targets = worktrees.filter((worktree) => !worktree.inUse)
    if (worktreePath !== undefined) {
      const requestedPath = canonicalPathSync(path.resolve(worktreePath))
      const target = worktrees.find((worktree) => canonicalPathSync(worktree.worktreePath) === requestedPath)
      if (!target) {
        throw new ScheduleServiceError('Worktree not found for this schedule', 404)
      }
      if (target.inUse) {
        throw new ScheduleServiceError('This worktree is in use by a running run. Cancel the run first.', 409)
      }
      targets = [target]
    }

    for (const target of targets) {
      try {
        await this.worktreeManager.releaseWorktree(repo, job, target.worktreePath)
      } catch (error) {
        throw new ScheduleServiceError(
          `Failed to remove worktree ${target.worktreePath}: ${getErrorMessage(error)}`,
          500,
        )
      }
      clearScheduleRunWorktreePath(this.db, repoId, jobId, target.worktreePath)
      if (this.onWorktreeRemoved) {
        await this.onWorktreeRemoved(target.worktreePath)
      }
    }

    return { removed: targets.length }
  }

  listAllRuns(options: ListAllRunsOptions = {}): ScheduleRunWithContext[] {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
    const offset = Math.max(options.offset ?? 0, 0)
    return listAllScheduleRuns(this.db, { ...options, limit, offset })
  }

  listUnreadRuns(limit: number): ScheduleRunWithUnreadPreview[] {
    return listUnreadScheduleRuns(this.db, limit)
  }

  countUnreadRuns(): { total: number; failed: number } {
    return countUnreadScheduleRuns(this.db)
  }

  markRunViewed(runId: number): boolean {
    return markScheduleRunViewed(this.db, runId)
  }

  markAllRunsViewed(): number {
    return markAllScheduleRunsViewed(this.db)
  }

  async recoverRunningRuns(): Promise<void> {
    const runningRuns = listRunningScheduleRuns(this.db)

    for (const run of runningRuns) {
      const job = getScheduleJobById(this.db, run.repoId, run.jobId)
      if (!job) {
        continue
      }

      if (ScheduleService.activeRuns.has(job.id)) {
        continue
      }

      ScheduleService.activeRuns.set(job.id, {
        runId: run.id,
        abort: new AbortController(),
        recovered: true,
      })
      await this.recoverRunningRun(job, run)
    }
  }

  listJobs(repoId: number): ScheduleJob[] {
    this.assertRepo(repoId)
    return listScheduleJobsByRepo(this.db, repoId)
  }

  listServerJobs(serverId: string): ScheduleJob[] {
    return listScheduleJobsByServer(this.db, serverId)
  }

  getJob(repoId: number, jobId: number): ScheduleJob | null {
    return getScheduleJobById(this.db, repoId, jobId)
  }

  getServerJob(serverId: string, jobId: number): ScheduleJob | null {
    const job = getScheduleJobById(this.db, null, jobId)
    return job && job.serverId === serverId ? job : null
  }

  async createJob(repoId: number, input: CreateScheduleJobRequest): Promise<ScheduleJob> {
    return this.createJobForTarget({ kind: 'repo', repoId }, input)
  }

  async createServerJob(serverId: string, directory: string, input: CreateScheduleJobRequest): Promise<ScheduleJob> {
    if (!path.isAbsolute(directory)) {
      throw new ScheduleServiceError('A remote schedule requires an absolute target directory', 400)
    }
    return this.createJobForTarget({ kind: 'server', serverId, directory }, input)
  }

  private async createJobForTarget(target: ScheduleJobTarget, input: CreateScheduleJobRequest): Promise<ScheduleJob> {
    this.assertInPlaceWorkspace(target, input.workspaceMode)
    const context = this.resolveTargetContext(target)
    this.assertSandboxJobSupported(context.serverId, input.sandbox)
    await this.assertAgentAvailable(context.client, context.directory, input.agentSlug?.trim() || null)
    const request =
      target.kind === 'server'
        ? {
            ...input,
            workspaceMode: 'in-place' as const,
            directory: context.directory,
            branch: null,
          }
        : { ...input, directory: undefined }

    try {
      const job = createScheduleJob(
        this.db,
        context.repoId,
        buildCreateSchedulePersistenceInput(request),
        context.serverId,
      )
      this.onJobChange?.(job, job.id)
      return job
    } catch (error) {
      throw new ScheduleServiceError(getErrorMessage(error), 400)
    }
  }

  async updateJob(repoId: number, jobId: number, input: UpdateScheduleJobRequest): Promise<ScheduleJob> {
    return this.updateJobForTarget({ kind: 'repo', repoId }, jobId, input)
  }

  async updateServerJob(serverId: string, jobId: number, input: UpdateScheduleJobRequest): Promise<ScheduleJob> {
    if (input.directory !== undefined && input.directory !== null && !path.isAbsolute(input.directory)) {
      throw new ScheduleServiceError('A remote schedule requires an absolute target directory', 400)
    }
    return this.updateJobForTarget({ kind: 'server', serverId, directory: '' }, jobId, input)
  }

  private async updateJobForTarget(
    target: ScheduleJobTarget,
    jobId: number,
    input: UpdateScheduleJobRequest,
  ): Promise<ScheduleJob> {
    const existing = this.loadJobForTarget(target, jobId)
    this.assertInPlaceWorkspace(target, input.workspaceMode)
    const context = this.resolveTargetContext(target, input.directory ?? existing.directory)
    if (input.sandbox !== undefined) {
      this.assertSandboxJobSupported(context.serverId, input.sandbox)
    }

    if (input.agentSlug !== undefined) {
      await this.assertAgentAvailable(context.client, context.directory, input.agentSlug?.trim() || null)
    }

    if (input.workspaceMode !== undefined && input.workspaceMode !== existing.workspaceMode) {
      const running =
        ScheduleService.activeRuns.has(jobId) || getRunningScheduleRunByJob(this.db, context.repoId, jobId) !== null
      if (running) {
        throw new ScheduleServiceError('Cannot change where runs execute while a run is in progress.', 409)
      }
    }

    const request =
      target.kind === 'server'
        ? {
            ...input,
            workspaceMode: 'in-place' as const,
            directory: input.directory ?? existing.directory ?? context.directory,
            branch: null,
          }
        : { ...input, directory: undefined }

    let job: ScheduleJob | null

    try {
      job = updateScheduleJob(this.db, context.repoId, jobId, buildUpdatedSchedulePersistenceInput(existing, request))
    } catch (error) {
      throw new ScheduleServiceError(getErrorMessage(error), 400)
    }

    if (!job) {
      throw new ScheduleServiceError('Schedule not found', 404)
    }
    this.onJobChange?.(job, job.id)
    return job
  }

  async deleteJob(repoId: number, jobId: number): Promise<void> {
    return this.deleteJobForTarget({ kind: 'repo', repoId }, jobId)
  }

  async deleteServerJob(serverId: string, jobId: number): Promise<void> {
    return this.deleteJobForTarget({ kind: 'server', serverId, directory: '' }, jobId)
  }

  private async deleteJobForTarget(target: ScheduleJobTarget, jobId: number): Promise<void> {
    const job = this.loadJobForTarget(target, jobId)
    const { repoId } = this.resolveTargetPersistence(target)

    if (ScheduleService.activeRuns.has(jobId)) {
      throw new ScheduleServiceError('Cannot delete a schedule while it is running. Cancel the run first.', 409)
    }

    const runningRun = getRunningScheduleRunByJob(this.db, repoId, jobId)
    if (runningRun) {
      throw new ScheduleServiceError('Cannot delete a schedule while it is running. Cancel the run first.', 409)
    }

    this.onJobChange?.(null, jobId)
    ScheduleService.activeRuns.set(jobId, {
      runId: DELETION_RESERVATION_RUN_ID,
      abort: new AbortController(),
    })

    try {
      if (target.kind === 'repo') {
        await this.removeWorktrees(target.repoId, jobId)
      }

      const deleted = deleteScheduleJob(this.db, repoId, jobId)
      if (!deleted) {
        throw new ScheduleServiceError('Schedule not found', 404)
      }
    } catch (error) {
      this.onJobChange?.(job, jobId)
      throw error
    } finally {
      ScheduleService.releaseActiveRun(jobId, DELETION_RESERVATION_RUN_ID)
    }
  }

  async prepareRepoDelete(repoId: number): Promise<void> {
    const jobIds = listScheduleJobIdsByRepo(this.db, repoId)

    for (const jobId of jobIds) {
      if (ScheduleService.activeRuns.has(jobId)) {
        throw new ScheduleServiceError(
          'Cannot delete a repo while a schedule run is in progress. Cancel the run first.',
          409,
        )
      }

      const runningRun = getRunningScheduleRunByJob(this.db, repoId, jobId)
      if (runningRun) {
        throw new ScheduleServiceError(
          'Cannot delete a repo while a schedule run is in progress. Cancel the run first.',
          409,
        )
      }
    }

    for (const jobId of jobIds) {
      this.onJobChange?.(null, jobId)
      await this.removeWorktrees(repoId, jobId)
    }
  }

  /**
   * Removes any schedule_jobs and schedule_runs whose repo_id (or job_id for
   * runs) no longer exists in the repos / schedule_jobs table.  Safe to call
   * on every startup — no-op when there are no orphans.
   */
  cleanupOrphanedSchedules(): { orphanedJobs: number; orphanedRuns: number } {
    const result = cleanupOrphanedSchedules(this.db)
    if (result.orphanedJobs > 0 || result.orphanedRuns > 0) {
      logger.info(`Cleaned up ${result.orphanedJobs} orphaned schedule job(s) and ${result.orphanedRuns} run(s)`)
    }
    return result
  }

  listRuns(repoId: number, jobId: number, limit: number = 20): ScheduleRun[] {
    this.assertJob(repoId, jobId)
    return listScheduleRunsByJob(this.db, repoId, jobId, limit)
  }

  listServerRuns(serverId: string, jobId: number, limit: number = 20): ScheduleRun[] {
    this.loadJobForTarget({ kind: 'server', serverId, directory: '' }, jobId)
    return listScheduleRunsByJob(this.db, null, jobId, limit)
  }

  getRun(repoId: number, jobId: number, runId: number): ScheduleRun {
    this.assertJob(repoId, jobId)
    const run = getScheduleRunById(this.db, repoId, jobId, runId)
    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }
    return run
  }

  /**
   * Records the outcome a scheduled session reports for its running run. The run status still
   * reflects whether the agent turn ended; the outcome reflects whether the task succeeded.
   */
  reportOutcome(
    sessionId: string,
    input: ScheduleOutcomeReportInput,
    agent: string | null,
  ): { runId: number; jobId: number; outcome: ScheduleRunOutcome } {
    const run = getRunningScheduleRunBySessionId(this.db, sessionId)
    if (!run) {
      throw new ScheduleServiceError(
        'OCM_OUTCOME_NO_RUNNING_RUN: no running scheduled run is linked to this session',
        404,
      )
    }

    updateScheduleRunOutcomeReport(this.db, run.repoId, run.jobId, run.id, {
      ...input,
      reportedAt: Date.now(),
      agent,
      reportCount: (run.outcomeReport?.reportCount ?? 0) + 1,
    })
    return { runId: run.id, jobId: run.jobId, outcome: input.outcome }
  }

  getServerRun(serverId: string, jobId: number, runId: number): ScheduleRun {
    this.loadJobForTarget({ kind: 'server', serverId, directory: '' }, jobId)
    const run = getScheduleRunById(this.db, null, jobId, runId)
    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }
    return run
  }

  /**
   * Clears a job's run history: deletes every finished run's row plus its git
   * run branch and any leftover worktree. A run currently in progress is left
   * untouched (its row and live worktree are skipped). `worktrees` controls
   * whether a worktree still on disk is committed and kept (`commit`) or
   * discarded along with its branch (`discard`).
   */
  async clearRunHistory(
    repoId: number,
    jobId: number,
    worktrees: ScheduleRunWorktreesMode = 'commit',
  ): Promise<{ cleared: number }> {
    return this.clearRunHistoryForTarget({ kind: 'repo', repoId }, jobId, worktrees)
  }

  async clearServerRunHistory(serverId: string, jobId: number): Promise<{ cleared: number }> {
    return this.clearRunHistoryForTarget({ kind: 'server', serverId, directory: '' }, jobId)
  }

  private async clearRunHistoryForTarget(
    target: ScheduleJobTarget,
    jobId: number,
    worktrees: ScheduleRunWorktreesMode = 'commit',
  ): Promise<{ cleared: number }> {
    const job = this.loadJobForTarget(target, jobId)
    const { repo, repoId } = this.resolveTargetPersistence(target)

    const removable = listScheduleRunArtifactsByJob(this.db, repoId, jobId).filter((run) => run.status !== 'running')
    if (removable.length === 0) {
      return { cleared: 0 }
    }

    if (repo) {
      await this.worktreeManager.pruneRunArtifacts(repo, job, removable, worktrees)
    }
    const cleared = deleteScheduleRunsByIds(
      this.db,
      repoId,
      jobId,
      removable.map((run) => run.id),
    )
    return { cleared }
  }

  /**
   * Deletes a single finished run plus its git run branch and any leftover
   * worktree. A run in progress must be cancelled first. `worktrees` controls
   * whether a worktree still on disk is committed and kept (`commit`) or
   * discarded along with its branch (`discard`).
   */
  async deleteRun(
    repoId: number,
    jobId: number,
    runId: number,
    worktrees: ScheduleRunWorktreesMode = 'commit',
  ): Promise<void> {
    return this.deleteRunForTarget({ kind: 'repo', repoId }, jobId, runId, worktrees)
  }

  async deleteServerRun(serverId: string, jobId: number, runId: number): Promise<void> {
    return this.deleteRunForTarget({ kind: 'server', serverId, directory: '' }, jobId, runId)
  }

  private async deleteRunForTarget(
    target: ScheduleJobTarget,
    jobId: number,
    runId: number,
    worktrees: ScheduleRunWorktreesMode = 'commit',
  ): Promise<void> {
    const job = this.loadJobForTarget(target, jobId)
    const { repo, repoId } = this.resolveTargetPersistence(target)
    const run = getScheduleRunById(this.db, repoId, jobId, runId)

    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }
    if (run.status === 'running') {
      throw new ScheduleServiceError('Cannot delete a run while it is in progress. Cancel it first.', 409)
    }

    if (repo) {
      await this.worktreeManager.pruneRunArtifacts(
        repo,
        job,
        [{ runBranch: run.runBranch, worktreePath: run.worktreePath }],
        worktrees,
      )
    }
    const deleted = deleteScheduleRunById(this.db, repoId, jobId, runId)
    if (!deleted) {
      throw new ScheduleServiceError('Run not found', 404)
    }
  }

  async runJob(repoId: number, jobId: number, triggerSource: ScheduleRunTriggerSource): Promise<ScheduleRun> {
    return this.runJobForTarget({ kind: 'repo', repoId }, jobId, triggerSource)
  }

  async runServerJob(serverId: string, jobId: number, triggerSource: ScheduleRunTriggerSource): Promise<ScheduleRun> {
    return this.runJobForTarget({ kind: 'server', serverId, directory: '' }, jobId, triggerSource)
  }

  async runJobForJob(job: ScheduleJob, triggerSource: ScheduleRunTriggerSource): Promise<ScheduleRun> {
    return this.runJobForTarget(this.targetForJob(job), job.id, triggerSource)
  }

  private async runJobForTarget(
    target: ScheduleJobTarget,
    jobId: number,
    triggerSource: ScheduleRunTriggerSource,
  ): Promise<ScheduleRun> {
    const job = this.loadJobForTarget(target, jobId)
    const repoId = target.kind === 'repo' ? target.repoId : null
    const serverId = target.kind === 'repo' ? LOCAL_OPENCODE_SERVER_ID : target.serverId

    const existingRunningRun = getRunningScheduleRunByJob(this.db, repoId, jobId)
    if (existingRunningRun) {
      throw new ScheduleServiceError('Schedule is already running', 409)
    }

    if (ScheduleService.activeRuns.has(jobId)) {
      throw new ScheduleServiceError('Schedule is already running', 409)
    }

    const startedAt = Date.now()
    const deadlineAt = startedAt + getRunDeadlineMs()
    const run = createScheduleRun(this.db, {
      jobId,
      repoId,
      serverId,
      triggerSource,
      status: 'running',
      startedAt,
      createdAt: startedAt,
    })

    const abort = new AbortController()
    const startup = Promise.withResolvers<void>()
    ScheduleService.activeRuns.set(jobId, {
      runId: run.id,
      abort,
      pendingStartup: startup,
    })
    let repo: Repo | null = null
    let sessionId: string | null = null
    const startupDeadline = new RunDeadline(deadlineAt, () => {
      try {
        if (getScheduleRunById(this.db, repoId, jobId, run.id)?.status === 'running') {
          updateScheduleRunMetadata(this.db, repoId, jobId, run.id, {
            errorText: buildRunDeadlineErrorText(deadlineAt - startedAt),
          })
        }
      } catch {
        logger.error('Failed to record an expired schedule startup', {
          runId: run.id,
        })
      }
    })

    try {
      const context = this.resolveTargetContext(target, job.directory)
      repo = context.repo
      this.assertSandboxJobSupported(context.serverId, job.sandbox)

      let runDirectory = context.directory
      if (repo) {
        const wt = await this.worktreeManager.prepare(repo, job, run.id)
        if (wt) {
          runDirectory = wt.directory
          updateScheduleRunWorktree(this.db, repoId, jobId, run.id, {
            worktreePath: wt.worktreePath,
            runBranch: wt.runBranch,
          })
        }
      }

      if (abort.signal.aborted) {
        return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo)
      }

      if (Date.now() >= deadlineAt) throw new RunDeadlineAbortError(deadlineAt)
      const runJob = {
        ...job,
        agentSlug: await startupDeadline.race(this.resolveRunAgent(context.client, runDirectory, job.agentSlug)),
      }
      const model = await startupDeadline.race(
        resolveOpenCodeModel(context.client, runDirectory, {
          preferredModel: job.model,
          signal: AbortSignal.any([abort.signal, startupDeadline.signal]),
        }),
      )

      if (abort.signal.aborted) {
        return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo)
      }

      await this.connectMcpServers(context.client, runDirectory, job.mcpServers)

      if (abort.signal.aborted) {
        return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo)
      }

      if (Date.now() >= deadlineAt) throw new RunDeadlineAbortError(deadlineAt)
      const sessionTitle = buildSessionTitle(job)
      let session: { id: string }
      try {
        session = await context.client.api.session.create({
          title: sessionTitle,
          agent: runJob.agentSlug ?? undefined,
          model: {
            providerID: model.providerID,
            id: model.id,
            variant: model.variant,
          },
          ...openCodeLocation(runDirectory),
          permissions: buildSchedulePermissionRuleset(job.permissionConfig),
        })
      } catch (error) {
        if (abort.signal.aborted) {
          return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo)
        }
        throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to create OpenCode session', 502)
      }

      sessionId = session.id

      if (abort.signal.aborted) {
        return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo, session.id)
      }

      if (Date.now() >= deadlineAt) throw new RunDeadlineAbortError(deadlineAt)
      const runWithSession = updateScheduleRunMetadata(this.db, repoId, jobId, run.id, {
        sessionId: session.id,
        sessionTitle,
        logText: buildRunStartedLog({
          job: runJob,
          triggerSource,
          sessionId: session.id,
          sessionTitle,
        }),
      })

      if (!runWithSession) {
        throw new ScheduleServiceError('Failed to attach session to run', 500)
      }

      if (job.sandbox?.enabled === true) {
        await this.startRunSandbox(runDirectory, job.sandbox, session.id)
        if (abort.signal.aborted) {
          return this.abandonCancelledStartup(context.client, repoId, jobId, run, job, repo, session.id)
        }
      }

      if (Date.now() >= deadlineAt) throw new RunDeadlineAbortError(deadlineAt)
      const sessionMonitor = createSessionMonitor(runDirectory, session.id, context.serverId)
      ScheduleService.attachSessionMonitor(jobId, run.id, sessionMonitor)

      void this.submitPromptAndMonitor({
        deadlineAt,
        repoId,
        repo,
        client: context.client,
        job: runJob,
        runId: run.id,
        sessionId: session.id,
        sessionTitle,
        triggerSource,
        sessionMonitor,
        directory: runDirectory,
        serverId: context.serverId,
      })

      return runWithSession
    } catch (error) {
      if (abort.signal.aborted) {
        return this.abandonCancelledStartup(
          target.kind === 'repo' ? this.openCodeClient : this.safeServerClient(target.serverId),
          repoId,
          jobId,
          run,
          job,
          repo,
          sessionId ?? undefined,
        )
      }

      const finishedAt = Date.now()
      const expired = Date.now() >= deadlineAt
      const errorText = expired ? buildRunDeadlineErrorText(deadlineAt - startedAt) : getErrorMessage(error)
      if (expired)
        logger.warn('Schedule startup exceeded its deadline', {
          jobId,
          runId: run.id,
        })
      else logger.error(`Failed to run schedule ${jobId}:`, error)

      const failedRun = updateScheduleRun(this.db, repoId, jobId, run.id, {
        status: 'failed',
        finishedAt,
        sessionId,
        errorText,
        logText: buildRunLog({
          job,
          triggerSource,
          errorText,
          finishedAt,
        }),
      })

      try {
        updateScheduleJobRunState(this.db, repoId, jobId, {
          lastRunAt: finishedAt,
          nextRunAt: triggerSource === 'manual' ? job.nextRunAt : computeNextRunAtForJob(job, finishedAt),
        })
      } catch (updateError) {
        logger.error(`Failed to update job state for job ${jobId}:`, updateError)
      }

      await this.teardownRunResources(repoId, jobId, run.id, job, repo, sessionId)

      ScheduleService.releaseActiveRun(jobId, run.id)

      if (!failedRun) {
        throw new ScheduleServiceError('Failed to load failed run', 500)
      }

      if (!expired && error instanceof ScheduleServiceError) {
        throw error
      }

      throw new ScheduleServiceError(errorText, 500)
    } finally {
      startupDeadline.clear()
      startup.resolve()
      const active = ScheduleService.activeRuns.get(jobId)
      if (active?.runId === run.id) delete active.pendingStartup
    }
  }

  async cancelRun(repoId: number, jobId: number, runId: number): Promise<ScheduleRun> {
    return this.cancelRunForTarget({ kind: 'repo', repoId }, jobId, runId)
  }

  async cancelServerRun(serverId: string, jobId: number, runId: number): Promise<ScheduleRun> {
    return this.cancelRunForTarget({ kind: 'server', serverId, directory: '' }, jobId, runId)
  }

  private async cancelRunForTarget(target: ScheduleJobTarget, jobId: number, runId: number): Promise<ScheduleRun> {
    const job = this.loadJobForTarget(target, jobId)
    let context: ScheduleTargetContext

    try {
      context = this.resolveTargetContext(target, job.directory)
    } catch (error) {
      if (target.kind !== 'server' || !(error instanceof ServerUnavailableError)) {
        throw error
      }
      return this.cancelUnavailableServerRun(job, jobId, runId)
    }

    const run = getScheduleRunById(this.db, context.repoId, jobId, runId)

    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }

    if (run.status !== 'running') {
      throw new ScheduleServiceError('Only running schedule runs can be cancelled', 409)
    }

    const startupOwner = ScheduleService.activeRuns.get(jobId)
    if (startupOwner?.runId === runId && startupOwner.pendingStartup) {
      ScheduleService.requestCancel(jobId, runId)
      startupOwner.startupCancellation = true
      startupOwner.abort.abort()
      try {
        await startupOwner.pendingStartup.promise
        const current = this.getRunById(context.repoId, jobId, runId)
        if (current.status !== 'running') {
          ScheduleService.settleCancel(jobId, runId, current.status)
          return current
        }
        if (current.sessionId) await this.interruptCancelledSession(context.client, current.sessionId)
        return await this.finalizeCancelledRun(context.repo, job, current, context.repoId, jobId, runId)
      } catch (error) {
        this.settleCancelFromState(context.repoId, jobId, runId)
        throw error
      }
    }
    if (!run.sessionId) {
      ScheduleService.abortActiveRun(jobId, runId)
      return this.finalizeCancelledRun(context.repo, job, run, context.repoId, jobId, runId)
    }

    ScheduleService.requestCancel(jobId, runId)

    try {
      const active = ScheduleService.activeRuns.get(jobId)
      const pendingSubmission = active?.runId === runId ? active.pendingSubmission : undefined
      if (!pendingSubmission && getScheduleSubmission(this.db, runId)?.state === 'pending') {
        throw new ScheduleServiceError(
          'SUBMISSION_UNCONFIRMED: Delivery is not yet confirmed; execution resources are retained.',
          409,
        )
      }
      await pendingSubmission
      let outcome: AssistantOutcome
      try {
        outcome = await this.readAssistantOutcome(context.client, run.sessionId)
      } catch (error) {
        throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to cancel schedule run', 502)
      }

      if (outcome.kind === 'stopped' && getScheduleSubmission(this.db, runId)) {
        throw new ScheduleServiceError(
          'SUBMISSION_UNCONFIRMED: The accepted submission has not been observed executing; execution resources are retained.',
          409,
        )
      }
      if (outcome.kind === 'settled') {
        await this.finalizeRecoveredRun(
          job,
          run,
          {
            status: outcome.errorText ? 'failed' : 'completed',
            responseText: outcome.responseText,
            errorText: outcome.errorText,
          },
          context.repo,
        )
        ScheduleService.resolveCancel(jobId, runId, 'settled')
        return this.getRunById(context.repoId, jobId, runId)
      }

      try {
        await context.client.api.session.interrupt({
          sessionID: run.sessionId,
        })
      } catch (error) {
        throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to cancel schedule run', 502)
      }

      if (pendingSubmission && (await this.isSessionActive(context.client, run.sessionId))) {
        throw new ScheduleServiceError('CANCELLATION_UNCONFIRMED: The submitted session is still active.', 502)
      }
      return await this.finalizeCancelledRun(context.repo, job, run, context.repoId, jobId, runId)
    } catch (error) {
      this.settleCancelFromState(context.repoId, jobId, runId)
      throw error
    }
  }

  private async cancelUnavailableServerRun(job: ScheduleJob, jobId: number, runId: number): Promise<ScheduleRun> {
    const run = getScheduleRunById(this.db, null, jobId, runId)

    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }

    if (run.status !== 'running') {
      throw new ScheduleServiceError('Only running schedule runs can be cancelled', 409)
    }

    if (getScheduleSubmission(this.db, runId)) {
      throw new ScheduleServiceError(
        'CANCELLATION_UNCONFIRMED: The server is unavailable; submitted execution resources are retained.',
        409,
      )
    }
    const owner = ScheduleService.activeRuns.get(jobId)
    const startedInThisProcess = owner?.runId === runId && owner.recovered !== true
    if (run.sessionId && !startedInThisProcess) {
      throw new ScheduleServiceError(
        'CANCELLATION_UNCONFIRMED: The server is unavailable and the linked session cannot be observed; execution resources are retained.',
        409,
      )
    }
    ScheduleService.requestCancel(jobId, runId)
    ScheduleService.abortActiveRun(jobId, runId)
    ScheduleService.disposeActiveRunMonitor(jobId, runId)
    return this.finalizeCancelledRun(null, job, run, null, jobId, runId)
  }

  private getRunById(repoId: number | null, jobId: number, runId: number): ScheduleRun {
    const run = getScheduleRunById(this.db, repoId, jobId, runId)
    if (!run) {
      throw new ScheduleServiceError('Run not found', 404)
    }
    return run
  }

  private settleCancelFromState(repoId: number | null, jobId: number, runId: number): void {
    let status: ScheduleRun['status'] | undefined
    try {
      status = getScheduleRunById(this.db, repoId, jobId, runId)?.status
    } catch {
      status = undefined
    }

    ScheduleService.settleCancel(jobId, runId, status)
  }

  private async finalizeCancelledRun(
    repo: Repo | null,
    job: ScheduleJob,
    run: ScheduleRun,
    repoId: number | null,
    jobId: number,
    runId: number,
  ): Promise<ScheduleRun> {
    const finishedAt = Date.now()
    const cancellationMessage = 'Run cancelled by user.'
    const cancelledRun = updateScheduleRun(this.db, repoId, jobId, runId, {
      status: 'cancelled',
      finishedAt,
      sessionId: run.sessionId,
      sessionTitle: run.sessionTitle,
      errorText: cancellationMessage,
      responseText: run.responseText,
      logText: buildRunLog({
        job,
        triggerSource: run.triggerSource,
        sessionId: run.sessionId,
        sessionTitle: run.sessionTitle,
        responseText: run.responseText,
        errorText: cancellationMessage,
        finishedAt,
      }),
    })

    updateScheduleJobRunState(this.db, repoId, jobId, {
      lastRunAt: finishedAt,
      nextRunAt: job.nextRunAt,
    })

    await this.teardownRunResources(repoId, jobId, runId, job, repo, run.sessionId)
    ScheduleService.releaseActiveRun(jobId, runId)
    ScheduleService.resolveCancel(jobId, runId, 'cancelled')

    if (!cancelledRun) {
      throw new ScheduleServiceError('Failed to update cancelled run', 500)
    }

    return this.getRunById(repoId, jobId, runId)
  }

  private async submitPromptAndMonitor(input: {
    deadlineAt: number
    repoId: number | null
    repo: Repo | null
    client: OpenCodeClient
    serverId: string
    job: ScheduleJob
    runId: number
    sessionId: string
    sessionTitle: string
    triggerSource: ScheduleRunTriggerSource
    sessionMonitor: SessionMonitor
    directory: string
  }): Promise<void> {
    let cleanupHandedOff = false
    let promptSubmitted = false
    let messageId = ''
    const submissionDeadline = new RunDeadline(input.deadlineAt, () => {
      if (!promptSubmitted) return
      try {
        if (getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)?.status === 'running') {
          updateScheduleRunMetadata(this.db, input.repoId, input.job.id, input.runId, {
            errorText: buildRunDeadlineErrorText(getRunDeadlineMs()),
          })
        }
      } catch {
        logger.error('Failed to record an expired schedule submission', {
          runId: input.runId,
        })
      }
    })
    try {
      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      if (Date.now() >= input.deadlineAt) throw new RunDeadlineAbortError(input.deadlineAt)
      const skills = await submissionDeadline.race(
        this.resolveSkillAttachments(input.client, input.directory, input.job.skillMetadata),
      )

      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      if (Date.now() >= input.deadlineAt) throw new RunDeadlineAbortError(input.deadlineAt)
      const notes = input.job.skillMetadata?.notes?.trim()
      messageId = `msg_${randomUUID().replaceAll('-', '').slice(0, 26)}`
      beginScheduleSubmission(this.db, {
        runId: input.runId,
        sessionId: input.sessionId,
        messageId,
        createdAt: Date.now(),
      })
      promptSubmitted = true
      const submission = Promise.withResolvers<void>()
      const active = ScheduleService.activeRuns.get(input.job.id)
      if (active?.runId === input.runId) active.pendingSubmission = submission.promise
      try {
        const accepted = await input.client.api.session.prompt({
          sessionID: input.sessionId,
          id: messageId,
          text: notes ? `${input.job.prompt}\n\nSkill notes: ${notes}` : input.job.prompt,
          ...(skills.length > 0 ? { skills } : {}),
        })
        try {
          if (accepted.id === messageId && accepted.sessionID === input.sessionId) {
            acknowledgeScheduleSubmission(this.db, {
              runId: input.runId,
              messageId,
              acknowledgedAt: Date.now(),
            })
          } else {
            logger.warn('Schedule submission acknowledgement did not match; retaining pending state', {
              runId: input.runId,
            })
          }
        } catch {
          logger.warn('Could not persist schedule submission acknowledgement; retaining pending state', {
            runId: input.runId,
          })
        }
      } finally {
        submission.resolve()
        if (active?.runId === input.runId) delete active.pendingSubmission
      }

      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      if (Date.now() >= input.deadlineAt) throw new RunDeadlineAbortError(input.deadlineAt)
      input.sessionMonitor.markSubmitted()

      cleanupHandedOff = true
      submissionDeadline.clear()
      await this.monitorRunCompletion({
        directory: input.directory,
        deadlineAt: input.deadlineAt,
        sessionMonitor: input.sessionMonitor,
        repoId: input.repoId,
        repo: input.repo,
        client: input.client,
        serverId: input.serverId,
        job: input.job,
        runId: input.runId,
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        triggerSource: input.triggerSource,
      })
      return
    } catch (error) {
      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      const finishedAt = Date.now()
      const errorText = getErrorMessage(error)
      if (promptSubmitted && Date.now() >= input.deadlineAt) {
        cleanupHandedOff = true
        input.sessionMonitor.dispose()
        try {
          const current = getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)
          if (current?.status === 'running') {
            await this.expireRecoveredRun(input.job, current, {
              repo: input.repo,
              repoId: input.repoId,
              serverId: input.serverId,
              directory: input.directory,
              client: input.client,
            })
          }
        } catch {
          logger.error('Failed to resolve an expired schedule submission', {
            runId: input.runId,
          })
        }
        return
      }
      logger.error(`Failed to submit prompt for schedule ${input.job.id}:`, error)

      const currentRun = getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)
      if (!currentRun || currentRun.status !== 'running') {
        return
      }

      if (
        promptSubmitted &&
        (!isDefinitePromptRejection(error) ||
          (await this.observeSubmittedMessage(input.client, input.sessionId, messageId)) !== 'absent')
      ) {
        cleanupHandedOff = true
        input.sessionMonitor.dispose()
        logger.warn('Schedule prompt delivery is unconfirmed; retaining execution resources', {
          runId: input.runId,
        })
        void this.recoverRunningRun(input.job, currentRun)
        return
      }

      updateScheduleRun(this.db, input.repoId, input.job.id, input.runId, {
        status: 'failed',
        finishedAt,
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        errorText,
        logText: buildRunLog({
          job: input.job,
          triggerSource: input.triggerSource,
          sessionId: input.sessionId,
          sessionTitle: input.sessionTitle,
          errorText,
          finishedAt,
        }),
      })

      updateScheduleJobRunState(this.db, input.repoId, input.job.id, {
        lastRunAt: finishedAt,
        nextRunAt:
          input.triggerSource === 'manual' ? input.job.nextRunAt : computeNextRunAtForJob(input.job, finishedAt),
      })
    } finally {
      submissionDeadline.clear()
      if (!cleanupHandedOff) {
        await ScheduleService.awaitCancelDecision(input.job.id, input.runId)
        input.sessionMonitor.dispose()
        await this.teardownRunResources(input.repoId, input.job.id, input.runId, input.job, input.repo, input.sessionId)
        ScheduleService.releaseActiveRun(input.job.id, input.runId)
        ScheduleService.clearCancel(input.job.id, input.runId)
      }
    }
  }

  private async monitorRunCompletion(input: {
    directory: string
    sessionMonitor: SessionMonitor
    repoId: number | null
    repo: Repo | null
    client: OpenCodeClient
    serverId: string
    job: ScheduleJob
    runId: number
    sessionId: string
    sessionTitle: string
    triggerSource: ScheduleRunTriggerSource
    deadlineAt?: number
  }): Promise<void> {
    const deadline = input.deadlineAt === undefined ? undefined : new RunDeadline(input.deadlineAt, () => {})
    let handedOff = false
    try {
      const state = this.readSettledAssistantState(input.client, input.sessionId)
      const currentAssistantState = await (deadline ? deadline.race(state) : state)
      if (currentAssistantState) {
        if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
          return
        }

        await this.finalizeRecoveredRun(
          input.job,
          {
            id: input.runId,
            repoId: input.repoId,
            jobId: input.job.id,
            sessionId: input.sessionId,
            sessionTitle: input.sessionTitle,
            triggerSource: input.triggerSource,
          } as ScheduleRun,
          {
            status: currentAssistantState.errorText ? 'failed' : 'completed',
            responseText: currentAssistantState.responseText,
            errorText: currentAssistantState.errorText,
          },
          input.repo,
        )
        return
      }

      const responsePromise = this.waitForAssistantMessage(input.client, input.sessionId, input.sessionMonitor)
      const response = await (deadline ? deadline.race(responsePromise) : responsePromise)

      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      const currentRun = getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)
      if (!currentRun || currentRun.status !== 'running') {
        return
      }

      const finishedAt = Date.now()

      if (response.errorText) {
        updateScheduleRun(this.db, input.repoId, input.job.id, input.runId, {
          status: 'failed',
          finishedAt,
          sessionId: input.sessionId,
          sessionTitle: input.sessionTitle,
          errorText: response.errorText,
          responseText: response.responseText,
          logText: buildRunLog({
            job: input.job,
            triggerSource: input.triggerSource,
            sessionId: input.sessionId,
            sessionTitle: input.sessionTitle,
            responseText: response.responseText,
            errorText: response.errorText,
            finishedAt,
          }),
        })
      } else {
        updateScheduleRun(this.db, input.repoId, input.job.id, input.runId, {
          status: 'completed',
          finishedAt,
          sessionId: input.sessionId,
          sessionTitle: input.sessionTitle,
          responseText: response.responseText,
          logText: buildRunLog({
            job: input.job,
            triggerSource: input.triggerSource,
            sessionId: input.sessionId,
            sessionTitle: input.sessionTitle,
            responseText: response.responseText,
            finishedAt,
          }),
        })
      }

      updateScheduleJobRunState(this.db, input.repoId, input.job.id, {
        lastRunAt: finishedAt,
        nextRunAt:
          input.triggerSource === 'manual' ? input.job.nextRunAt : computeNextRunAtForJob(input.job, finishedAt),
      })
    } catch (error) {
      if (error instanceof RunDeadlineAbortError) {
        handedOff = true
        input.sessionMonitor.dispose()
        try {
          const current = getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)
          if (current?.status === 'running') {
            await this.expireRecoveredRun(input.job, current, {
              repo: input.repo,
              repoId: input.repoId,
              serverId: input.serverId,
              directory: input.directory,
              client: input.client,
            })
          }
        } catch {
          logger.error('Failed to handle an expired recovered schedule run', {
            runId: input.runId,
          })
        }
        return
      }
      if ((await ScheduleService.awaitCancelDecision(input.job.id, input.runId)) !== 'resume') {
        return
      }

      logger.error(`Failed to monitor schedule ${input.job.id}:`, error)

      const currentRun = getScheduleRunById(this.db, input.repoId, input.job.id, input.runId)
      if (!currentRun || currentRun.status !== 'running') {
        return
      }

      handedOff = true
      input.sessionMonitor.dispose()
      void this.retryUnobservedRun(input.job, currentRun, {
        repo: input.repo,
        client: input.client,
        directory: input.directory,
        repoId: input.repoId,
        serverId: input.serverId,
      })
    } finally {
      deadline?.clear()
      if (!handedOff) {
        await ScheduleService.awaitCancelDecision(input.job.id, input.runId)
        input.sessionMonitor.dispose()
        await this.teardownRunResources(input.repoId, input.job.id, input.runId, input.job, input.repo, input.sessionId)
        ScheduleService.releaseActiveRun(input.job.id, input.runId)
        ScheduleService.clearCancel(input.job.id, input.runId)
      }
    }
  }

  private async recoverRunningRun(job: ScheduleJob, run: ScheduleRun): Promise<void> {
    const target = this.targetForJob(job)
    let repo: Repo | null = null
    let resolved: ScheduleTargetContext | null = null

    try {
      const context = this.resolveTargetContext(target, job.directory)
      resolved = context
      repo = context.repo
      const runDirectory = run.worktreePath ?? context.directory

      if (!run.sessionId) {
        await this.finalizeRecoveredRun(
          job,
          run,
          {
            status: 'failed',
            errorText: 'This run was interrupted before completion and had no linked session to recover.',
          },
          repo,
        )
        return
      }

      const submission = getScheduleSubmission(this.db, run.id)
      if (submission?.state === 'pending') {
        void this.monitorPendingSubmission(job, run, context, submission.message_id)
        return
      }
      const outcome = await this.readAssistantOutcome(context.client, run.sessionId)

      if (submission && outcome.kind === 'stopped') {
        void this.monitorPendingSubmission(job, run, context, submission.message_id)
        return
      }

      if (outcome.kind === 'settled') {
        await this.finalizeRecoveredRun(
          job,
          run,
          {
            status: outcome.errorText ? 'failed' : 'completed',
            responseText: outcome.responseText,
            errorText: outcome.errorText,
          },
          repo,
        )
        return
      }

      if (outcome.kind === 'busy') {
        const deadlineMs = getRunDeadlineMs()
        if (run.startedAt + deadlineMs <= Date.now()) {
          await this.expireRecoveredRun(job, run, context)
          return
        }
        const sessionMonitor = createSessionMonitor(runDirectory, run.sessionId, context.serverId)
        ScheduleService.attachSessionMonitor(job.id, run.id, sessionMonitor)
        void this.monitorRunCompletion({
          directory: runDirectory,
          sessionMonitor,
          repoId: run.repoId,
          repo,
          client: context.client,
          serverId: context.serverId,
          job,
          runId: run.id,
          sessionId: run.sessionId,
          sessionTitle: run.sessionTitle ?? buildSessionTitle(job),
          triggerSource: run.triggerSource,
          deadlineAt: run.startedAt + deadlineMs,
        })
        return
      }

      await this.finalizeRecoveredRun(
        job,
        run,
        {
          status: 'failed',
          responseText: outcome.responseText,
          errorText:
            'This run was interrupted before completion, likely because OpenCode Manager restarted while it was in progress. Open the linked session to inspect the partial output and rerun if needed.',
        },
        repo,
      )
    } catch (error) {
      logger.error(`Failed to recover schedule ${job.id}:`, error)
      if (run.sessionId) {
        void this.retryUnobservedRun(job, run, resolved)
        return
      }
      const errorText = getErrorMessage(error)
      await this.finalizeRecoveredRun(
        job,
        run,
        {
          status: 'failed',
          errorText,
        },
        repo,
      )
    }
  }

  /**
   * Retains a run whose execution state or target could not be read and retries recovery on the next
   * session or server-connection signal, or after 30 seconds. Recovery resolves the target again, so a
   * temporarily unavailable server keeps the run, its resources and its active-run reservation.
   */
  private async retryUnobservedRun(
    job: ScheduleJob,
    run: ScheduleRun,
    context: ScheduleTargetContext | null,
  ): Promise<void> {
    if (!run.sessionId) return
    logger.warn('Schedule execution state is unknown; retaining execution resources', { runId: run.id })
    const directory = run.worktreePath ?? context?.directory ?? job.directory ?? ''
    const serverId = context?.serverId ?? job.serverId ?? LOCAL_OPENCODE_SERVER_ID
    const monitor = createSessionMonitor(directory, run.sessionId, serverId)
    ScheduleService.attachSessionMonitor(job.id, run.id, monitor)
    let latest: ScheduleRun | null = null
    try {
      while (true) {
        if ((await monitor.nextSignal(30_000)).disposed) return
        if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') return
        try {
          latest = getScheduleRunById(this.db, run.repoId, job.id, run.id)
          break
        } catch {
          logger.warn('Could not read a retained schedule run; retrying', { runId: run.id })
        }
      }
    } finally {
      monitor.dispose()
    }
    if (latest?.status !== 'running') return
    if (context && latest.startedAt + getRunDeadlineMs() <= Date.now()) {
      await this.expireRecoveredRun(job, latest, context)
      return
    }
    await this.recoverRunningRun(job, latest)
  }

  /** Pages a session's user messages for the submission's message ID; throws when paging cannot complete. */
  private async findSubmittedMessage(
    client: OpenCodeClient,
    sessionId: string,
    messageId: string,
    observation: RunDeadline,
  ): Promise<boolean> {
    let cursor: string | undefined
    const visited = new Set<string>()
    for (let page = 0; page < 1000; page++) {
      const messages = await observation.race(
        client.api.message.list(
          {
            sessionID: sessionId,
            type: 'user',
            limit: 100,
            ...(cursor ? { cursor } : { order: 'asc' }),
          },
          { signal: observation.signal },
        ),
      )
      if (messages.data.some((message) => message.id === messageId && message.type === 'user')) return true
      const next = messages.cursor.next
      if (!next) return false
      if (!messages.data.length || visited.has(next) || page === 999) {
        throw new ScheduleServiceError('SUBMISSION_OBSERVATION_INCOMPLETE', 502)
      }
      visited.add(next)
      cursor = next
    }
    return false
  }

  /**
   * One bounded check of whether a prompt whose call failed was admitted anyway. Only a complete read
   * without the message ID proves absence; any read failure leaves delivery unknown.
   */
  private async observeSubmittedMessage(
    client: OpenCodeClient,
    sessionId: string,
    messageId: string,
  ): Promise<'admitted' | 'absent' | 'unknown'> {
    const observation = new RunDeadline(Date.now() + 10_000, () => {})
    try {
      return (await this.findSubmittedMessage(client, sessionId, messageId, observation)) ? 'admitted' : 'absent'
    } catch {
      return 'unknown'
    } finally {
      observation.clear()
    }
  }

  private async monitorPendingSubmission(
    job: ScheduleJob,
    run: ScheduleRun,
    context: ScheduleTargetContext,
    messageId: string,
  ): Promise<void> {
    if (!run.sessionId) return
    const monitor = createSessionMonitor(run.worktreePath ?? context.directory, run.sessionId, context.serverId)
    ScheduleService.attachSessionMonitor(job.id, run.id, monitor)
    try {
      while (true) {
        if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') return
        const current = getScheduleRunById(this.db, run.repoId, job.id, run.id)
        if (current?.status !== 'running') return
        const observation = new RunDeadline(Date.now() + 10_000, () => {})
        let observed = false
        try {
          if (await this.findSubmittedMessage(context.client, run.sessionId, messageId, observation)) {
            const outcome = await observation.race(this.readAssistantOutcome(context.client, run.sessionId))
            observed = outcome.kind !== 'stopped'
          }
        } catch {
          logger.warn('Schedule submission remains unconfirmed; retaining execution resources', { runId: run.id })
        } finally {
          observation.clear()
        }
        if (observed) {
          if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') return
          if (getScheduleSubmission(this.db, run.id)?.state === 'pending') {
            acknowledgeScheduleSubmission(this.db, {
              runId: run.id,
              messageId,
              acknowledgedAt: Date.now(),
            })
          }
          await this.recoverRunningRun(job, current)
          return
        }
        if ((await monitor.nextSignal(30_000)).disposed) return
      }
    } catch {
      logger.error('Failed to observe a pending schedule submission', {
        runId: run.id,
      })
    } finally {
      monitor.dispose()
    }
  }

  private async finalizeRecoveredRun(
    job: ScheduleJob,
    run: ScheduleRun,
    input: {
      status: 'completed' | 'failed'
      responseText?: string | null
      errorText?: string | null
    },
    repo: Repo | null,
  ): Promise<void> {
    const finishedAt = Date.now()

    updateScheduleRun(this.db, run.repoId, run.jobId, run.id, {
      status: input.status,
      finishedAt,
      sessionId: run.sessionId,
      sessionTitle: run.sessionTitle,
      responseText: input.responseText,
      errorText: input.errorText,
      logText: buildRunLog({
        job,
        triggerSource: run.triggerSource,
        sessionId: run.sessionId,
        sessionTitle: run.sessionTitle,
        responseText: input.responseText,
        errorText: input.errorText,
        finishedAt,
      }),
    })

    updateScheduleJobRunState(this.db, run.repoId, run.jobId, {
      lastRunAt: finishedAt,
      nextRunAt: run.triggerSource === 'manual' ? job.nextRunAt : computeNextRunAtForJob(job, finishedAt),
    })

    await this.teardownRunResources(run.repoId, run.jobId, run.id, job, repo, run.sessionId)
    ScheduleService.releaseActiveRun(job.id, run.id)
  }

  private async interruptCancelledSession(client: OpenCodeClient, sessionId: string): Promise<void> {
    try {
      await client.api.session.interrupt({ sessionID: sessionId })
    } catch (error) {
      logger.error(`Failed to interrupt cancelled schedule session ${sessionId}:`, error)
    }
  }

  private async expireRecoveredRun(job: ScheduleJob, run: ScheduleRun, context: ScheduleTargetContext): Promise<void> {
    if (!run.sessionId) return
    const errorText = buildRunDeadlineErrorText(getRunDeadlineMs())
    const interrupted = await this.interruptExpiredSession(context.client, run.sessionId)
    if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') {
      ScheduleService.clearCancel(job.id, run.id)
      return
    }
    const current = getScheduleRunById(this.db, run.repoId, job.id, run.id)
    if (current?.status !== 'running') {
      ScheduleService.releaseActiveRun(job.id, run.id)
      return
    }
    if (!interrupted) {
      updateScheduleRunMetadata(this.db, run.repoId, job.id, run.id, {
        errorText,
      })
      void this.monitorExpiredRun(job, current, context)
      return
    }
    await this.finalizeRecoveredRun(job, current, { status: 'failed', errorText }, context.repo)
  }

  private async monitorExpiredRun(job: ScheduleJob, run: ScheduleRun, context: ScheduleTargetContext): Promise<void> {
    const sessionID = run.sessionId
    if (!sessionID) return
    const monitor = createSessionMonitor(run.worktreePath ?? context.directory, sessionID, context.serverId)
    ScheduleService.attachSessionMonitor(job.id, run.id, monitor)
    try {
      while (true) {
        if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') return
        const current = getScheduleRunById(this.db, run.repoId, job.id, run.id)
        if (!current || current.status !== 'running') return
        const deadline = new RunDeadline(Date.now() + 10_000, () => {})
        let inactive = false
        try {
          const active = await deadline.race(context.client.api.session.active({ signal: deadline.signal }))
          inactive = !active[sessionID]
        } catch (error) {
          logger.warn('Could not observe an expired schedule session; preserving its resources', {
            sessionID,
            reason: error instanceof RunDeadlineAbortError ? 'timeout' : 'request-failed',
          })
        } finally {
          deadline.clear()
        }
        if (inactive) {
          if ((await ScheduleService.awaitCancelDecision(job.id, run.id)) !== 'resume') return
          const latest = getScheduleRunById(this.db, run.repoId, job.id, run.id)
          if (latest?.status === 'running') {
            await this.finalizeRecoveredRun(
              job,
              latest,
              {
                status: 'failed',
                errorText: latest.errorText ?? buildRunDeadlineErrorText(getRunDeadlineMs()),
              },
              context.repo,
            )
          }
          return
        }
        if ((await monitor.nextSignal(30_000)).disposed) return
      }
    } catch {
      logger.error('Failed to monitor an expired schedule run', {
        runId: run.id,
      })
    } finally {
      monitor.dispose()
      const pending = ScheduleService.pendingCancels.get(job.id)
      if (pending?.runId === run.id && pending.resolved) ScheduleService.clearCancel(job.id, run.id)
    }
  }

  private async interruptExpiredSession(client: OpenCodeClient, sessionID: string): Promise<boolean> {
    const deadline = new RunDeadline(Date.now() + 10_000, () => {})
    try {
      await deadline.race(client.api.session.interrupt({ sessionID }, { signal: deadline.signal }))
      const active = await deadline.race(client.api.session.active({ signal: deadline.signal }))
      if (active[sessionID]) {
        logger.warn('Expired schedule session is still active; preserving its resources', { sessionID })
        return false
      }
      return true
    } catch (error) {
      logger.warn('Could not confirm interruption of an expired schedule session; preserving its resources', {
        sessionID,
        reason: error instanceof RunDeadlineAbortError ? 'timeout' : 'request-failed',
      })
      return false
    } finally {
      deadline.clear()
    }
  }

  private loadRun(repoId: number | null, jobId: number, runId: number, fallback: ScheduleRun): ScheduleRun {
    return getScheduleRunById(this.db, repoId, jobId, runId) ?? fallback
  }

  private async abandonCancelledStartup(
    client: OpenCodeClient,
    repoId: number | null,
    jobId: number,
    run: ScheduleRun,
    job: ScheduleJob,
    repo: Repo | null,
    sessionId?: string,
  ): Promise<ScheduleRun> {
    const owner = ScheduleService.activeRuns.get(jobId)
    if (owner?.runId === run.id && owner.startupCancellation) {
      if (sessionId)
        updateScheduleRunMetadata(this.db, repoId, jobId, run.id, {
          sessionId,
        })
      owner.pendingStartup?.resolve()
      await ScheduleService.awaitCancelDecision(jobId, run.id)
      ScheduleService.clearCancel(jobId, run.id)
      return this.loadRun(repoId, jobId, run.id, run)
    }
    if (sessionId) {
      await this.interruptCancelledSession(client, sessionId)
    }
    ScheduleService.clearCancel(jobId, run.id)
    await this.teardownRunResources(repoId, jobId, run.id, job, repo, sessionId ?? run.sessionId)
    ScheduleService.releaseActiveRun(jobId, run.id)
    return this.loadRun(repoId, jobId, run.id, run)
  }

  private async teardownRunResources(
    repoId: number | null,
    jobId: number,
    runId: number,
    job: ScheduleJob,
    repo: Repo | null,
    sessionId?: string | null,
  ): Promise<void> {
    const key = `${repoId}:${jobId}:${runId}`
    if (ScheduleService.activeTeardowns.has(key)) return
    ScheduleService.activeTeardowns.add(key)
    try {
      try {
        const run = getScheduleRunById(this.db, repoId, jobId, runId)
        const rootSessionId = sessionId ?? run?.sessionId
        if (run && rootSessionId && run.status !== 'running' && run.usage?.error !== null) {
          const additional = run.outcomeReport?.additionalUsage ?? null
          let snapshot
          try {
            const context = this.resolveTargetContext(this.targetForJob(job), job.directory)
            snapshot = await captureScheduleRunUsage(context.client.api, rootSessionId, additional)
          } catch {
            snapshot = {
              usage: buildFailedUsage('USAGE_SNAPSHOT_FAILED', additional),
              agentUsed: null,
            }
          }
          updateScheduleRunUsage(this.db, run, snapshot)
        }
      } catch {
        logger.warn('Failed to persist scheduled run usage', { runId })
      }
      const fresh = getScheduleRunById(this.db, repoId, jobId, runId)
      try {
        if (repo && fresh?.worktreePath) {
          await this.finalizeRunWorktree(
            repo,
            job,
            runId,
            fresh.worktreePath,
            fresh.runBranch,
            fresh.triggerSource,
            repoId,
            jobId,
          )
        }
      } finally {
        await this.removeRunSandbox(sessionId ?? fresh?.sessionId ?? null)
      }
    } finally {
      ScheduleService.activeTeardowns.delete(key)
    }
  }

  private async finalizeRunWorktree(
    repo: Repo,
    job: ScheduleJob,
    runId: number,
    worktreePath: string,
    runBranch: string | null,
    triggerSource: ScheduleRunTriggerSource,
    repoId: number | null,
    jobId: number,
  ): Promise<void> {
    const remainingWorktreePath = () => (existsSync(worktreePath) ? worktreePath : null)
    try {
      const { commitHash } = await this.worktreeManager.finalize(repo, job, {
        id: runId,
        worktreePath,
        runBranch,
        triggerSource,
      })
      updateScheduleRunWorktree(this.db, repoId, jobId, runId, {
        worktreePath: remainingWorktreePath(),
        commitHash,
      })
    } catch (error) {
      logger.error(`Failed to finalize worktree for run ${runId}:`, error)
      updateScheduleRunWorktree(this.db, repoId, jobId, runId, {
        worktreePath: remainingWorktreePath(),
      })
    }
  }

  private async removeRunSandbox(sessionId: string | null): Promise<void> {
    const runtime = this.sandbox?.runtime
    if (!sessionId || !runtime) return
    const mode = getSessionSandboxMode(this.db, sessionId)
    if (mode?.sandboxed !== true && mode?.source !== 'user') return
    try {
      await runtime.removeSessionSandbox(sessionId)
    } catch (error) {
      logger.warn(
        `Failed to remove the sandbox microVM for scheduled run session ${sessionId}: ${getErrorMessage(error)}`,
      )
    }
  }

  /**
   * An assistant message completing is not the end of a run: a multi-step agent
   * settles one message per tool call. Only a session that has gone idle has
   * finished, and only then is the final message guaranteed to carry its content.
   */
  private async readAssistantOutcome(client: OpenCodeClient, sessionId: string): Promise<AssistantOutcome> {
    if (await this.isSessionActive(client, sessionId)) {
      return { kind: 'busy' }
    }

    const assistantState = await this.readAssistantReply(client, sessionId)
    if (assistantState?.completed || assistantState?.errorText) {
      return {
        kind: 'settled',
        responseText: assistantState.responseText,
        errorText: assistantState.errorText,
      }
    }

    return {
      kind: 'stopped',
      responseText: assistantState?.responseText ?? null,
    }
  }

  private async readSettledAssistantState(
    client: OpenCodeClient,
    sessionId: string,
  ): Promise<{ responseText: string | null; errorText: string | null } | null> {
    const outcome = await this.readAssistantOutcome(client, sessionId)
    return outcome.kind === 'settled' ? { responseText: outcome.responseText, errorText: outcome.errorText } : null
  }

  private async waitForAssistantMessage(
    client: OpenCodeClient,
    sessionId: string,
    sessionMonitor: SessionMonitor,
  ): Promise<{ responseText: string | null; errorText: string | null }> {
    for (;;) {
      const signal = await sessionMonitor.nextSignal()

      if (signal.errorText || signal.disposed) {
        const assistantState = await this.readAssistantReply(client, sessionId)
        return {
          responseText: assistantState?.responseText ?? null,
          errorText: signal.errorText ?? SESSION_STOPPED_ERROR,
        }
      }

      const outcome = await this.readAssistantOutcome(client, sessionId)

      if (outcome.kind === 'busy') {
        continue
      }

      if (outcome.kind === 'settled') {
        return {
          responseText: outcome.responseText,
          errorText: outcome.errorText,
        }
      }

      return {
        responseText: outcome.responseText,
        errorText: SESSION_STOPPED_ERROR,
      }
    }
  }

  private async readAssistantReply(client: OpenCodeClient, sessionId: string): Promise<AssistantReplyState | null> {
    try {
      return await readLatestAssistantReply(client, sessionId)
    } catch (error) {
      throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to fetch session messages', 502)
    }
  }

  private async isSessionActive(client: OpenCodeClient, sessionId: string): Promise<boolean> {
    try {
      return await isSessionBusy(client, sessionId)
    } catch (error) {
      throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to fetch active sessions', 502)
    }
  }

  private async listAgentIds(client: OpenCodeClient, directory: string): Promise<Set<string>> {
    try {
      const response = await client.api.agent.list(openCodeLocation(directory))
      return new Set(response.data.filter((agent) => agent.mode !== 'subagent').map((agent) => agent.id))
    } catch {
      throw new ScheduleServiceError('AGENT_CHECK_FAILED: Could not verify the agents available for this run.', 502)
    }
  }

  /**
   * OpenCode admits a prompt for a session whose agent does not exist at its location
   * but never delivers it. Reject an unavailable selected agent instead of substituting another agent.
   */
  private async resolveRunAgent(
    client: OpenCodeClient,
    directory: string,
    agentSlug: string | null,
  ): Promise<string | null> {
    if (!agentSlug) {
      return null
    }

    if ((await this.listAgentIds(client, directory)).has(agentSlug)) {
      return agentSlug
    }

    throw new ScheduleServiceError(
      `AGENT_NOT_AVAILABLE: Agent "${agentSlug}" is not available in ${directory}. Choose an available primary agent or clear the agent selection.`,
      422,
    )
  }

  private async assertAgentAvailable(
    client: OpenCodeClient,
    directory: string,
    agentSlug: string | null,
  ): Promise<void> {
    if (!agentSlug) {
      return
    }

    if (!(await this.listAgentIds(client, directory)).has(agentSlug)) {
      throw new ScheduleServiceError(
        `Agent "${agentSlug}" is not available in ${directory}. Choose an agent defined for this repo in the schedule settings, or clear the agent to use the default.`,
        400,
      )
    }
  }

  /**
   * Makes every MCP server attached to the job available at the run's location before the
   * session starts. Schedule-only servers are added to that location, and configured servers
   * are connected even when their config disables them; both last until OpenCode restarts.
   */
  private async connectMcpServers(
    client: OpenCodeClient,
    directory: string,
    servers: ScheduleJob['mcpServers'],
  ): Promise<void> {
    if (servers.length === 0) {
      return
    }

    const api = client.api
    const location = openCodeLocation(directory)
    const readStatuses = async () => mcpStatusByName((await api.mcp.list(location)).data)

    try {
      await Promise.all(
        servers.flatMap((server) =>
          server.config
            ? [
                api.mcp.add({
                  server: server.name,
                  config: server.config,
                  ...location,
                }),
              ]
            : [],
        ),
      )

      const statuses = await readStatuses()
      const missing = servers.filter((server) => !statuses[server.name]).map((server) => server.name)
      if (missing.length > 0) {
        throw new ScheduleServiceError(`MCP servers are not configured for this location: ${missing.join(', ')}`, 400)
      }

      await Promise.all(
        servers
          .filter((server) => statuses[server.name]?.status !== 'connected')
          .map((server) => api.mcp.connect({ server: server.name, ...location })),
      )

      const connected = await readStatuses()
      const failed = servers.flatMap((server) => {
        const status = connected[server.name]
        if (status?.status === 'connected') return []
        const reason = status && 'error' in status ? status.error : (status?.status ?? 'missing')
        return [`${server.name} (${reason})`]
      })
      if (failed.length > 0) {
        throw new ScheduleServiceError(`MCP servers failed to connect: ${failed.join(', ')}`, 502)
      }
    } catch (error) {
      if (error instanceof ScheduleServiceError) {
        throw error
      }
      throw new ScheduleServiceError(getErrorMessage(error) || 'Failed to connect MCP servers', 502)
    }
  }

  private async resolveSkillAttachments(
    client: OpenCodeClient,
    directory: string,
    skillMetadata: ScheduleJob['skillMetadata'],
  ): Promise<SkillAttachment[]> {
    const slugs = skillMetadata?.skillSlugs ?? []
    if (slugs.length === 0) {
      return []
    }

    let availableSkills: Set<string>
    try {
      const response = await client.api.skill.list(openCodeLocation(directory))
      availableSkills = new Set(response.data.map((skill) => skill.id))
    } catch (error) {
      logger.warn('Failed to list skills for the scheduled run; continuing without skill attachments:', error)
      return []
    }

    return slugs.flatMap((slug) => {
      if (!availableSkills.has(slug)) {
        logger.warn(`Skill "${slug}" is not available in this location; dropping it from the scheduled run`)
        return []
      }
      return [{ id: slug }]
    })
  }

  private assertRepo(repoId: number) {
    if (repoId === ASSISTANT_REPO_ID) {
      const repo = getRepoById(this.db, ASSISTANT_REPO_ID)
      if (repo) return repo
      return {
        ...buildAssistantRepo(),
        lastAccessedAt: Date.now(),
        isLocal: true,
        currentBranch: undefined,
      }
    }
    const repo = getRepoById(this.db, repoId)
    if (!repo) {
      throw new ScheduleServiceError('Repo not found', 404)
    }
    return repo
  }

  private assertJob(repoId: number, jobId: number) {
    const job = getScheduleJobById(this.db, repoId, jobId)
    if (!job) {
      throw new ScheduleServiceError('Schedule not found', 404)
    }
    return job
  }
}

interface Stoppable {
  stop(): void
}

function buildIntervalCronExpression(intervalMinutes: number): string | null {
  if (intervalMinutes < 5) {
    return null
  }

  if (intervalMinutes <= 59) {
    return `*/${intervalMinutes} * * * *`
  }

  if (intervalMinutes === 60) {
    return `0 * * * *`
  }

  const hours = intervalMinutes / 60
  if (Number.isInteger(hours) && 24 % hours === 0) {
    return `0 */${hours} * * *`
  }

  const days = intervalMinutes / 1440
  if (Number.isInteger(days)) {
    return `0 0 */${days} * *`
  }

  return null
}

export class ScheduleRunner {
  private cronJobs = new Map<number, Stoppable>()

  constructor(private readonly scheduleService: ScheduleService) {}

  async start(): Promise<void> {
    this.scheduleService.setJobChangeHandler((job, jobId) => {
      if (job) {
        this.registerJob(job)
      } else {
        this.unregisterJob(jobId)
      }
    })

    // Clean up any schedule records whose repo no longer exists.  This handles
    // leftovers from before foreign-key enforcement was enabled, and guards
    // against edge cases where a repo row was removed outside the normal flow.
    this.scheduleService.cleanupOrphanedSchedules()

    await this.scheduleService.recoverRunningRuns()
    this.registerAllEnabledJobs()
  }

  stop(): void {
    this.scheduleService.setJobChangeHandler(null)
    for (const stoppable of this.cronJobs.values()) {
      stoppable.stop()
    }
    this.cronJobs.clear()
  }

  registerJob(job: ScheduleJob): void {
    this.unregisterJob(job.id)

    if (!job.enabled) {
      return
    }

    if (job.scheduleMode === 'cron') {
      if (!job.cronExpression) {
        return
      }
      const options: Record<string, unknown> = { protect: true }
      if (job.timezone) {
        options.timezone = job.timezone
      }
      const cron = new Cron(job.cronExpression, options, () => {
        logger.info(`Cron triggered for job ${job.id}: ${job.name}`)
        void this.executeJob(job)
      })
      this.cronJobs.set(job.id, cron)
      logger.info(`Cron job created for ${job.id}: next run at ${cron.nextRun()?.toISOString()}`)
      return
    }

    if (!job.intervalMinutes) {
      return
    }

    if (!job.nextRunAt) {
      logger.warn(`Job ${job.id} (${job.name}) has no nextRunAt, skipping registration`)
      return
    }

    const cronExpression = buildIntervalCronExpression(job.intervalMinutes)
    const options: Record<string, unknown> = { protect: true }
    if (job.timezone) {
      options.timezone = job.timezone
    }

    if (cronExpression) {
      const nextRunDate = new Date(job.nextRunAt)
      const now = new Date()

      if (nextRunDate <= now) {
        void this.executeJob(job)
      }

      const cronOptions = {
        ...options,
        ...(nextRunDate > now ? { startAt: nextRunDate.toISOString() } : {}),
      }
      const cron = new Cron(cronExpression, cronOptions, () => {
        logger.info(`Cron triggered for job ${job.id}: ${job.name}`)
        void this.executeJob(job)
      })
      this.cronJobs.set(job.id, cron)
    } else {
      const intervalMs = job.intervalMinutes * 60_000
      let timeout: ReturnType<typeof setTimeout> | null = null
      let isStopped = false
      let isRunning = false

      const scheduleNext = () => {
        if (isStopped || isRunning) return
        timeout = setTimeout(async () => {
          if (isStopped || isRunning) return
          isRunning = true
          logger.info(`Interval timer triggered for job ${job.id}: ${job.name}`)
          try {
            await this.executeJob(job)
          } finally {
            isRunning = false
            scheduleNext()
          }
        }, intervalMs)
      }

      const initialDelay = Math.max(0, job.nextRunAt - Date.now())
      if (initialDelay > 0) {
        timeout = setTimeout(() => {
          if (isStopped || isRunning) return
          isRunning = true
          logger.info(`Interval timer triggered for job ${job.id}: ${job.name}`)
          void this.executeJob(job).finally(() => {
            isRunning = false
            scheduleNext()
          })
        }, initialDelay)
      } else {
        if (!isStopped) {
          isRunning = true
          void this.executeJob(job).finally(() => {
            isRunning = false
            scheduleNext()
          })
        }
      }

      this.cronJobs.set(job.id, {
        stop: () => {
          isStopped = true
          if (timeout) clearTimeout(timeout)
        },
      })
    }
  }

  unregisterJob(jobId: number): void {
    const existing = this.cronJobs.get(jobId)
    if (existing) {
      existing.stop()
      this.cronJobs.delete(jobId)
    }
  }

  private async executeJob(job: ScheduleJob): Promise<void> {
    try {
      await this.scheduleService.runJobForJob(job, 'schedule')
    } catch (error) {
      logger.error(`Scheduled run failed for job ${job.id}:`, error)
    }
  }

  private registerAllEnabledJobs(): void {
    const jobs = this.scheduleService.listAllEnabledJobs()
    logger.info(`Registering ${jobs.length} enabled schedule jobs`)
    for (const job of jobs) {
      try {
        logger.info(
          `Registering job ${job.id}: ${job.name} (mode=${job.scheduleMode}, cron=${job.cronExpression}, tz=${job.timezone})`,
        )
        this.registerJob(job)
        logger.info(`Job ${job.id} registered, cron jobs map size: ${this.cronJobs.size}`)
      } catch (error) {
        logger.error(`Failed to register job ${job.id}:`, error)
      }
    }
  }
}

export { ScheduleServiceError }
