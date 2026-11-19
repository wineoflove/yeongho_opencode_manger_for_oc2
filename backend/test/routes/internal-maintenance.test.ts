import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { allMigrations } from '../../src/db/migrations'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { migrate } from '../../src/db/migration-runner'
import type { OpenCodeClient } from '../../src/services/opencode/client'
import { createInternalTestApp } from '../helpers/internal-test-app'
import { maintenanceAdmission, maintenanceHttpAdmission } from '../../src/services/maintenance-admission'
import { getMaintenanceStatus } from '../../src/services/maintenance-status'
import { FetchOpenCodeClient } from '../../src/services/opencode/client'
import { buildOpenCodeBasicAuth, isSessionNotFoundError, openCodeErrorStatus } from '@opencode-manager/shared/opencode'
import { startOpenCodeServe } from '../helpers/opencode-binary'
import { createMcpOauthProxyRoutes } from '../../src/routes/mcp-oauth-proxy'
import { storeMcpOAuthFlow } from '../../src/services/mcp-oauth-state'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

type CleanupOwnership = { roots: string[]; descendants: { id: string; parentID: string }[]; removed?: string[] }
type CleanupSessions = (input: {
  api: OpenCodeClient['api']; directory: string; attempted: string[]; confirmed: string[]
  persistOwnership: (ownership: CleanupOwnership) => Promise<void>
}) => Promise<string[]>

type Api = { active: ReturnType<typeof vi.fn>; pty: ReturnType<typeof vi.fn>; locations: ReturnType<typeof vi.fn>; sessions: ReturnType<typeof vi.fn>; persistent: ReturnType<typeof vi.fn> }

function client(api: Api): OpenCodeClient {
  return {
    api: { session: { active: api.active, list: api.sessions }, pty: { list: api.pty }, debug: { location: { list: api.locations } }, experimental: { persistentPty: { list: api.persistent } } },
    forwardRaw: vi.fn(),
  } as unknown as OpenCodeClient
}

describe('internal/maintenance routes', () => {
  const nonce = 'a1234567-1234-4234-8234-123456789abc'
  const otherNonce = 'b1234567-1234-4234-8234-123456789abc'
  let db: Database
  let token: string
  let api: Api
  let app: Hono

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    token = getOrCreateInternalToken(db)
    api = {
      active: vi.fn(async () => ({})),
      pty: vi.fn(async () => ({ data: [] })),
      locations: vi.fn(async () => []),
      sessions: vi.fn(async () => ({ data: [], cursor: {} })),
      persistent: vi.fn(async () => []),
    }
    app = new Hono()
    app.use('/api/*', maintenanceHttpAdmission(maintenanceAdmission))
    app.route('/api/internal', createInternalTestApp(db, { openCodeClient: client(api) }))
  })
  afterEach(() => {
    maintenanceAdmission.exit(nonce)
    db.close()
  })
  const control = (action: 'enter' | 'seal' | 'exit', owner = nonce, authorization = `Bearer ${token}`) =>
    app.request(`/api/internal/maintenance/${action}`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: owner }),
    })

  const status = async () => {
    const response = await app.request('/api/internal/maintenance/status', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return (await response.json()) as {
      ready: boolean
      blockers: string[]
      counts: Record<string, number>
      schemaVersion: number
      drained: boolean
      admission: { pendingHandlers: number; closed: boolean }
      directories: { registered: string[]; attempted: string[]; checked: string[] }
    }
  }

  it('requires the internal bearer token', async () => {
    expect((await app.request('/api/internal/maintenance/status')).status).toBe(401)
    expect(api.active).not.toHaveBeenCalled()
  })

  it('reports ready with the version 1 contract when nothing is running', async () => {
    const body = await status()
    expect(body).toMatchObject({
      schemaVersion: 1,
      admission: { configured: false, closed: false, controlled: false, pendingHandlers: 0 },
      drained: false,
      ready: true,
      blockers: [],
      counts: {
        enabledSchedules: 0,
        activeSchedules: 0,
        activeRecovery: 0,
        busySessions: 0,
        terminalSessions: 0,
        checkedDirectories: 2,
        pendingHandlers: 0,
      },
    })
    expect(api.pty).toHaveBeenCalledTimes(2)
  })

  it.each(['enter', 'seal', 'exit'] as const)('authenticates %s with only the existing internal token', async (action) => {
    for (const authorization of ['', 'Bearer wrong', 'Basic dXNlcjp3cm9uZw==']) {
      expect((await control(action, nonce, authorization)).status).toBe(401)
    }
    expect((await app.request(`/api/internal/maintenance/${action}`, {
      method: 'POST', headers: { cookie: 'session=browser', 'content-type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })).status).toBe(401)
    expect(maintenanceAdmission.isClosed()).toBe(false)
  })

  it('requires a nonce and preserves exclusive, idempotent ownership', async () => {
    expect((await control('enter', 'bad')).status).toBe(400)
    expect((await control('enter')).status).toBe(200)
    expect((await control('enter')).status).toBe(200)
    expect((await control('exit', nonce, 'Bearer wrong')).status).toBe(401)
    expect((await app.request('/api/internal/unrelated', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })).status).toBe(503)
    expect((await control('enter', otherNonce)).status).toBe(409)
    expect((await control('exit', otherNonce)).status).toBe(409)
    expect((await status()).drained).toBe(false)
    expect((await control('seal', otherNonce)).status).toBe(409)
    expect((await control('seal')).status).toBe(200)
    expect((await control('seal')).status).toBe(200)
    expect((await status()).drained).toBe(true)
    expect((await control('exit')).status).toBe(200)
    expect((await control('exit')).status).toBe(200)
    expect((await status()).admission.closed).toBe(false)
  })

  it('preserves the existing Basic internal-token contract for controls', async () => {
    const authorization = `Basic ${Buffer.from(`internal:${token}`).toString('base64')}`
    expect((await control('enter', nonce, authorization)).status).toBe(200)
    expect((await control('exit', nonce, authorization)).status).toBe(200)
  })

  it('freezes admission before awaiting native evidence and drains a previously admitted handler', async () => {
    let finish!: () => void
    let admitted!: () => void
    const started = new Promise<void>((resolve) => { admitted = resolve })
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    app.post('/api/work', async (c) => { admitted(); await waiting; return c.json({ ok: true }) })
    const pending = app.request('/api/work', { method: 'POST' })
    await started
    try {
      expect((await control('enter')).status).toBe(200)
      expect((await app.request('/api/work', { method: 'POST' })).status).toBe(503)
      const body = await status()
      expect(body.drained).toBe(false)
      expect(body.blockers).toContain('pending_handlers')
      expect(body.counts.pendingHandlers).toBe(1)
    } finally { finish() }
    expect((await pending).status).toBe(200)
    await control('seal')
    expect((await status()).drained).toBe(true)
  })

  it('checks every registered native location, including non-repository terminals', async () => {
    api.locations.mockResolvedValue([{ directory: '/untracked/worktree' }])
    api.pty.mockImplementation(async (input: { location: { directory: string } }) => ({
      data: input.location.directory === '/untracked/worktree' ? [{ id: 'pty_extra' }] : [],
    }))
    const body = await status()
    expect(body.directories.registered).toEqual(['/untracked/worktree'])
    expect(body.directories.checked).toContain('/untracked/worktree')
    expect(body.counts.checkedDirectories).toBe(3)
    expect(body.counts.terminalSessions).toBe(1)
    expect(body.ready).toBe(false)
  })

  it('retains the enabled-schedule and active-run blockers while admission is closed', async () => {
    db.run(`INSERT INTO repos (repo_url, local_path, branch, default_branch, clone_status, cloned_at) VALUES ('https://example.invalid/r.git', 'r', 'main', 'main', 'ready', 1)`)
    db.run(`INSERT INTO schedule_jobs (repo_id, name, enabled, schedule_mode, interval_minutes, prompt, created_at, updated_at) VALUES (1, 'job', 1, 'interval', 60, 'p', 1, 1)`)
    db.run(`INSERT INTO schedule_runs (job_id, repo_id, trigger_source, status, started_at, created_at) VALUES (1, 1, 'manual', 'running', 1, 1)`)
    await control('enter')
    const body = await status()
    expect(body.blockers).toContain('enabled_schedules')
    expect(body.blockers).toContain('active_schedules')
    expect(body.drained).toBe(false)
  })

  it('fails closed when registered locations cannot be enumerated', async () => {
    api.locations.mockRejectedValue(new Error('unavailable'))
    expect((await status()).blockers).toContain('directories_unknown')
  })

  it('counts persistent PTYs in all paginated live and archived sessions', async () => {
    api.sessions.mockResolvedValueOnce({ data: [{ id: 'ses_live' }], cursor: { next: 'next' } })
      .mockResolvedValueOnce({ data: [{ id: 'ses_more' }], cursor: {} })
      .mockResolvedValueOnce({ data: [{ id: 'ses_archived' }], cursor: {} })
    api.persistent.mockResolvedValue([{ id: 'pty_persistent' }])
    const body = await status()
    expect(body.counts.persistentTerminalSessions).toBe(3)
    expect(api.persistent.mock.calls.map(([input]) => input.sessionID)).toEqual(['ses_live', 'ses_more', 'ses_archived'])
    expect(body.blockers).toContain('terminal_sessions')
  })

  it.each(['sessions', 'persistent'] as const)('fails closed on unknown persistent PTY evidence: %s', async (key) => {
    api.sessions.mockResolvedValue({ data: [{ id: 'ses_live' }], cursor: {} })
    api[key].mockRejectedValue(new Error('unknown'))
    expect((await status()).blockers).toContain('persistent_pty_unknown')
  })

  it.each(['{', '{}', JSON.stringify({ nonce, extra: true })])('rejects malformed control body without changing admission: %s', async (body) => {
    const before = maintenanceAdmission.status()
    for (const action of ['enter', 'seal', 'exit']) {
      expect((await app.request(`/api/internal/maintenance/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
      })).status).toBe(400)
      expect(maintenanceAdmission.status()).toEqual(before)
    }
  })

  it('blocks a snapshot when a handler starts and ends with final pending zero', async () => {
    api.active.mockImplementation(async () => { maintenanceAdmission.admit()(); return {} })
    const body = await status()
    expect(body.counts.pendingHandlers).toBe(0)
    expect(body.blockers).toContain('admission_changed')
  })

  it('rejects a readiness snapshot if admission changes during native inspection', async () => {
    api.active.mockImplementation(async () => { maintenanceAdmission.enter(nonce); return {} })
    const body = await status()
    expect(body.blockers).toContain('admission_changed')
    expect(body.drained).toBe(false)
  })

  it('reports an already-admitted delayed OAuth callback as not drained after enter', async () => {
    storeMcpOAuthFlow({ state: 'delayed-status', serverName: 'fixture', integrationID: 'int_fixture', attemptID: 'attempt_fixture', callbackPort: 12345 })
    let finish!: (response: Response) => void
    const forward = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    app.route('/api/mcp-oauth-proxy', createMcpOauthProxyRoutes(client(api)))
    const pending = app.request('/api/mcp-oauth-proxy/callback?state=delayed-status&code=code')
    try {
      await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce())
      await control('enter')
      await control('seal')
      expect((await status()).drained).toBe(false)
      finish(new Response('ok'))
      await pending
      expect((await status()).drained).toBe(true)
    } finally { forward.mockRestore() }
  })

  it('verifies the installed native persistent PTY API is distinct from location PTYs and included in status', async () => {
    const helperPath = process.env.OCM_TEST_CLEANUP_HELPER
    const evidenceRoot = process.env.OCM_TEST_EVIDENCE_ROOT ?? tmpdir()
    if (!isAbsolute(evidenceRoot) || (helperPath && !isAbsolute(helperPath))) throw new Error('Absolute cleanup/evidence paths required')
    await mkdir(evidenceRoot, { recursive: true })
    const evidenceDirectory = await mkdtemp(join(evidenceRoot, 'ocm-final-persistent-cleanup-'))
    const evidenceFile = join(evidenceDirectory, 'receipt.json')
    const helper: { cleanupRoundRobinSessions: CleanupSessions } | undefined = helperPath
      ? await import(pathToFileURL(helperPath).href) : undefined
    const rootID = `ses_${randomBytes(16).toString('hex')}`
    const childID = `ses_${randomBytes(16).toString('hex')}`
    const confirmed: string[] = []
    let terminalID: string | undefined
    const ownedPtyIDs = new Set<string>()
    let ownership: CleanupOwnership = { roots: [rootID], descendants: [] }
    let remaining: string[] | null = null
    let ptyAbsent = false
    const cleanupErrors: string[] = []
    const serve = await startOpenCodeServe()
    const native = new FetchOpenCodeClient({ baseUrl: serve.baseUrl, basicAuth: buildOpenCodeBasicAuth(serve.password), defaultDirectory: false })
    const persist = async () => writeFile(evidenceFile, JSON.stringify({
      cleanupMode: helper ? 'oc2-cleanupRoundRobinSessions' : 'portable-sdk-known-fixture-ids',
      directory: serve.homeDirectory, rootID, childID, terminalID, ownedPtyIDs: [...ownedPtyIDs], confirmed, ownership,
      observedAt: new Date().toISOString(), remaining, remainingCount: remaining?.length ?? null,
      ptyAbsent, cleanupErrors, cleanupVerified: remaining?.length === 0 && ptyAbsent && cleanupErrors.length === 0,
    }, null, 2))
    const persistOwnership = async (value: CleanupOwnership) => { ownership = value; await persist() }
    try {
      await persist()
      const session = await native.api.session.create({ id: rootID, location: { directory: serve.homeDirectory }, title: 'maintenance-persistent-fixture' })
      confirmed.push(session.id)
      await persist()
      const child = await native.api.session.create({ id: childID, parentID: session.id, location: { directory: serve.homeDirectory }, title: 'maintenance-child-fixture' })
      confirmed.push(child.id)
      await persist()
      const terminal = await native.api.experimental.persistentPty.create({ sessionID: child.id,
        command: '/bin/sh', args: ['-c', 'cat'], cwd: serve.homeDirectory, title: 'maintenance-fixture', env: {},
      })
      terminalID = terminal.id
      ownedPtyIDs.add(terminal.id)
      await persist()
      const persistent = await native.api.experimental.persistentPty.list({ sessionID: child.id })
      expect(persistent.map((pty) => pty.id)).toContain(terminal.id)
      const regular = await native.api.pty.list({ location: { directory: serve.homeDirectory } })
      expect(regular.data.map((pty) => pty.id)).not.toContain(terminal.id)
      const body = await getMaintenanceStatus(db, native)
      expect(body.counts.persistentTerminalSessions).toBe(1)
      expect(body.persistentPty.checked).toContain(child.id)
      expect(body.blockers).toContain('terminal_sessions')
      expect(body.blockers).not.toContain('persistent_pty_unknown')
      await native.api.session.update({ sessionID: child.id, archived: true })
      const archivedBody = await getMaintenanceStatus(db, native)
      expect(archivedBody.counts.persistentTerminalSessions).toBe(1)
      expect(archivedBody.persistentPty.checked).toContain(child.id)
    } finally {
      const cleanup = async () => {
        try {
          if (confirmed.includes(childID)) {
            try {
              for (const pty of await native.api.experimental.persistentPty.list({ sessionID: childID })) ownedPtyIDs.add(pty.id)
            } catch (error) { cleanupErrors.push(`pty-discovery:${error instanceof Error ? error.message : 'unknown'}`) }
            await persist()
          }
          for (const ptyID of ownedPtyIDs) {
            try { await native.api.experimental.persistentPty.remove({ ptyID }) }
            catch (error) { if (openCodeErrorStatus(error) !== 404) throw error }
            try {
              await native.api.experimental.persistentPty.get({ ptyID })
              throw new Error('Owned PTY still exists')
            } catch (error) {
              if (openCodeErrorStatus(error) !== 404) throw error
            }
          }
          ptyAbsent = true
        } catch (error) { cleanupErrors.push(`pty:${error instanceof Error ? error.message : 'unknown'}`) }
        try {
          if (helper) await helper.cleanupRoundRobinSessions({
            api: native.api, directory: serve.homeDirectory, attempted: [rootID],
            confirmed: confirmed.filter((id) => id === rootID), persistOwnership,
          })
          else {
            await persistOwnership({ roots: [rootID], descendants: confirmed.includes(childID) ? [{ id: childID, parentID: rootID }] : [] })
            for (const id of [childID, rootID]) {
              const scope = { sessionID: id, location: { directory: serve.homeDirectory } }
              let session
              try { session = await native.api.session.get(scope) }
              catch (error) { if (isSessionNotFoundError(error) && error.sessionID === id) continue; throw error }
              expect(session.location.directory).toBe(serve.homeDirectory)
              expect(session.parentID ?? null).toBe(id === rootID ? null : rootID)
              await native.api.session.wait(scope)
              const children = await native.api.session.list({ parentID: id, directory: serve.homeDirectory, limit: 100 })
              expect(children.data).toEqual([])
              expect(children.cursor.next ?? null).toBeNull()
              await native.api.session.remove(scope)
              await persistOwnership({ ...ownership, removed: [...ownership.removed ?? [], id] })
            }
          }
        } catch (error) { cleanupErrors.push(`sessions:${error instanceof Error ? error.message : 'unknown'}`) }
        remaining = []
        for (const id of new Set([rootID, childID, ...ownership.descendants.map((entry) => entry.id)])) {
          const scope = { sessionID: id, location: { directory: serve.homeDirectory } }
          try { await native.api.session.get(scope); remaining.push(id) }
          catch (error) {
            if (!(isSessionNotFoundError(error) && error.sessionID === id)) {
              remaining.push(id)
              cleanupErrors.push(`readback:${id}`)
            }
          }
        }
        await persist()
        expect(cleanupErrors, evidenceFile).toEqual([])
        expect(remaining, evidenceFile).toEqual([])
        if (terminalID) expect(ptyAbsent, evidenceFile).toBe(true)
      }
      try { await cleanup() } finally { await serve.stop() }
    }
  }, 90_000)

  it('blocks on enabled schedules, running sessions, active goals and open terminals', async () => {
    db.run(
      `INSERT INTO repos (repo_url, local_path, branch, default_branch, clone_status, cloned_at) VALUES ('https://example.invalid/r.git', 'r', 'main', 'main', 'ready', 1)`,
    )
    db.run(
      `INSERT INTO schedule_jobs (repo_id, name, enabled, schedule_mode, interval_minutes, prompt, created_at, updated_at) VALUES (1, 'job', 1, 'interval', 60, 'p', 1, 1)`,
    )
    db.run(
      `INSERT INTO session_goals (session_id, directory, objective, status, max_continuations, created_at, updated_at) VALUES ('ses_a', '/w', 'o', 'active', 5, 1, 1)`,
    )
    api.active.mockResolvedValue({
      ses_a: { type: 'running' },
      ses_b: { type: 'running' },
    })
    api.pty.mockResolvedValueOnce({ data: [{ id: 'pty_1' }] })
    const body = await status()
    expect(body.ready).toBe(false)
    expect(body.blockers.sort()).toEqual(['active_recovery', 'busy_sessions', 'enabled_schedules', 'terminal_sessions'])
    expect(body.counts).toMatchObject({
      enabledSchedules: 1,
      activeRecovery: 1,
      busySessions: 2,
      terminalSessions: 1,
      checkedDirectories: 3,
    })
  })

  it('fails closed when OpenCode cannot report activity or terminals', async () => {
    api.active.mockRejectedValue(new Error('down'))
    api.pty.mockRejectedValue(new Error('down'))
    const body = await status()
    expect(body.ready).toBe(false)
    expect(body.blockers.sort()).toEqual(['directories_unknown', 'session_status_unknown'])
    expect(body.counts.checkedDirectories).toBe(0)
  })

  it.each([
    ['an array of active sessions', [], { data: [] }, ['session_status_unknown']],
    ['a terminal page without a data array', {}, { data: {} }, ['directories_unknown']],
    ['a terminal page that is not an object', {}, null, ['directories_unknown']],
  ])('fails closed when OpenCode returns %s', async (_label, active, terminals, blockers) => {
    api.active.mockResolvedValue(active)
    api.pty.mockResolvedValue(terminals)
    const body = await status()
    expect(body.ready).toBe(false)
    expect(body.blockers).toEqual(blockers)
    expect(Number.isNaN(body.counts.terminalSessions)).toBe(false)
  })
})
