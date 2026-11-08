import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { getLearningsEntriesPath } from '@opencode-manager/shared/config/env'
import { allMigrations } from '../../src/db/migrations'
import { migrate } from '../../src/db/migration-runner'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import type { OpenCodeClient } from '../../src/services/opencode/client'
import type { LearningScriptRequest, LearningScriptResult } from '../../src/services/learnings/script-runner'
import { createInternalTestApp } from '../helpers/internal-test-app'

const runner = vi.hoisted(() => ({
  fn: vi.fn<(request: LearningScriptRequest) => Promise<LearningScriptResult>>(),
}))

vi.mock('../../src/services/learnings/script-runner', () => ({
  runLearningScript: (request: LearningScriptRequest) => runner.fn(request),
}))

const recordInput = {
  title: '한국어 응답 선호',
  patternKey: 'communication.korean',
  status: 'pending',
  kind: 'preference',
  source: '사용자 교정',
  conditions: '모든 저장소의 사용자 응답',
  evidence: '사용자가 직접 확인',
  related: [],
  lesson: '영어 자료를 읽어도 한국어로 응답한다.',
  limits: '코드와 명령은 원문을 보존한다.',
}

function ok(stdout: string): LearningScriptResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false }
}

describe('internal/learnings routes', () => {
  let db: Database
  let app: Hono
  let token: string
  let sessionGet: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runner.fn.mockReset()
    db = new Database(':memory:')
    migrate(db, allMigrations)
    sessionGet = vi.fn()
    const openCodeClient = { api: { session: { get: sessionGet } } } as unknown as OpenCodeClient
    app = new Hono()
    app.route('/api/internal', createInternalTestApp(db, { openCodeClient }))
    token = getOrCreateInternalToken(db)
  })

  function post(pathname: string, body: unknown, auth = true) {
    return app.request(`/api/internal/learnings${pathname}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    })
  }

  it('POST /search returns 401 without bearer token', async () => {
    const res = await post('/search', { query: '한국어' }, false)
    expect(res.status).toBe(401)
    expect(runner.fn).not.toHaveBeenCalled()
  })

  it('POST /search builds bounded arguments and passes the script JSON through', async () => {
    const payload = '{"results":[{"id":"observation"}],"readOnly":true}\n'
    runner.fn.mockResolvedValue(ok(payload))

    const res = await post('/search', { query: '한국어 응답', limit: 3, maxChars: 2000, includePending: true })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe(payload)
    expect(runner.fn).toHaveBeenCalledWith({
      script: 'search.mjs',
      args: ['한국어 응답', '--limit', '3', '--max-chars', '2000', '--include-pending', '--entries', getLearningsEntriesPath()],
    })
  })

  it('POST /search omits --include-pending by default', async () => {
    runner.fn.mockResolvedValue(ok('{"results":[]}'))

    await post('/search', { query: '한국어' })

    expect(runner.fn.mock.calls[0]?.[0].args).toEqual([
      '한국어',
      '--limit',
      '5',
      '--max-chars',
      '6000',
      '--entries',
      getLearningsEntriesPath(),
    ])
  })

  it('POST /search returns 400 on invalid input without running the script', async () => {
    const res = await post('/search', { query: '', limit: 99 })
    expect(res.status).toBe(400)
    expect(runner.fn).not.toHaveBeenCalled()
  })

  it('POST /search maps a script exit 1 to 400 with the stderr error code', async () => {
    runner.fn.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '{"error":"LEARNING_SEARCH_INVALID_QUERY"}\n',
      timedOut: false,
    })

    const res = await post('/search', { query: 'a' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'LEARNING_SEARCH_INVALID_QUERY' })
  })

  it('POST /search returns 504 when the runner times out', async () => {
    runner.fn.mockResolvedValue({ exitCode: null, stdout: '', stderr: '', timedOut: true })

    const res = await post('/search', { query: '한국어' })

    expect(res.status).toBe(504)
  })

  it('POST /record allows a root session and pipes only the learning fields to record.mjs', async () => {
    sessionGet.mockResolvedValue({ id: 'ses_root1' })
    runner.fn.mockResolvedValue(
      ok('{"id":"20261014T000000Z-ab12-korean","path":"/x/20261014T000000Z-ab12-korean.md","status":"pending"}\n'),
    )

    const res = await post('/record', { ...recordInput, sessionID: 'ses_root1', agent: 'build' })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      id: '20261014T000000Z-ab12-korean',
      path: '/x/20261014T000000Z-ab12-korean.md',
      status: 'pending',
    })
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: 'ses_root1' })
    const call = runner.fn.mock.calls[0]?.[0]
    expect(call?.script).toBe('record.mjs')
    expect(call?.args).toEqual(['--entries', getLearningsEntriesPath()])
    expect(JSON.parse(call?.stdin ?? '')).toEqual(recordInput)
  })

  it('POST /record denies a subagent session with 403', async () => {
    sessionGet.mockResolvedValue({ id: 'ses_child1', parentID: 'ses_root1' })

    const res = await post('/record', { ...recordInput, sessionID: 'ses_child1', agent: 'explore' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'OCM_LEARNING_RECORD_SUBAGENT_DENIED' })
    expect(runner.fn).not.toHaveBeenCalled()
  })

  it('POST /record allows a schedule run session without looking up its parent', async () => {
    db.prepare(
      `INSERT INTO schedule_runs (job_id, trigger_source, status, started_at, created_at, session_id)
       VALUES (1, 'schedule', 'running', 1, 1, 'ses_sched1')`,
    ).run()
    runner.fn.mockResolvedValue(ok('{"id":"a","path":"/x/a.md","status":"pending"}'))

    const res = await post('/record', { ...recordInput, sessionID: 'ses_sched1', agent: null })

    expect(res.status).toBe(201)
    expect(sessionGet).not.toHaveBeenCalled()
  })

  it('POST /record returns 502 when the session lookup fails', async () => {
    sessionGet.mockRejectedValue(new Error('Session not found'))

    const res = await post('/record', { ...recordInput, sessionID: 'ses_root1', agent: 'build' })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'OCM_LEARNING_RECORD_SESSION_LOOKUP_FAILED' })
    expect(runner.fn).not.toHaveBeenCalled()
  })

  it('POST /record returns 400 on invalid input', async () => {
    const res = await post('/record', { ...recordInput, patternKey: 'Bad Key', sessionID: 'ses_root1', agent: 'build' })
    expect(res.status).toBe(400)
    expect(runner.fn).not.toHaveBeenCalled()
  })

  it('POST /record returns 400 on a malformed sessionID', async () => {
    const res = await post('/record', { ...recordInput, sessionID: '../etc', agent: 'build' })
    expect(res.status).toBe(400)
    expect(sessionGet).not.toHaveBeenCalled()
  })

  it('POST /record maps a script failure to 400 with its error code', async () => {
    sessionGet.mockResolvedValue({ id: 'ses_root1' })
    runner.fn.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '{"error":"LEARNING_RECORD_SECRET_DETECTED","field":"evidence"}\n',
      timedOut: false,
    })

    const res = await post('/record', { ...recordInput, sessionID: 'ses_root1', agent: 'build' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'LEARNING_RECORD_SECRET_DETECTED' })
  })

  it('GET /lint passes the report through and maps a script failure to 500', async () => {
    const report = '{"scanned":0,"counts":{"verified":0,"pending":0,"superseded":0,"other":0},"violations":[]}'
    runner.fn.mockResolvedValueOnce(ok(report))
    runner.fn.mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: '{"error":"LEARNING_LINT_FAILED"}',
      timedOut: false,
    })
    const headers = { authorization: `Bearer ${token}` }

    const passed = await app.request('/api/internal/learnings/lint', { headers })
    expect(passed.status).toBe(200)
    expect(await passed.text()).toBe(report)
    expect(runner.fn.mock.calls[0]?.[0]).toEqual({ script: 'lint.mjs', args: ['--entries', getLearningsEntriesPath()] })

    const failed = await app.request('/api/internal/learnings/lint', { headers })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'LEARNING_LINT_FAILED' })
  })
})
