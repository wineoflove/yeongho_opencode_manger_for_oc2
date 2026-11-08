import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionGoal } from '@opencode-manager/shared/schemas'
import { createInternalAgentGoalRoutes } from '../../src/routes/internal/agent-goals'
import { SessionGoalError, type SessionGoalService } from '../../src/services/session-goals'
import { createStubOpenCodeClient } from '../helpers/stub-opencode-client'

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return { id: 7, sessionId: 'ses_goal', status: 'active', objective: 'Ship it', ...overrides } as SessionGoal
}

describe('internal agent goal routes', () => {
  const service = {
    getLatest: vi.fn(),
    startFromRunningTurn: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }
  const sessionGet = vi.fn()
  const app = createInternalAgentGoalRoutes(
    service as unknown as SessionGoalService,
    createStubOpenCodeClient({ api: { session: { get: sessionGet } } as never }),
  )
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns the latest goal of the session, or null', async () => {
    service.getLatest.mockReturnValueOnce(goal()).mockReturnValueOnce(null)

    expect(await (await app.request('/?sessionId=ses_goal')).json()).toEqual({ goal: goal() })
    expect(await (await app.request('/?sessionId=ses_goal')).json()).toEqual({ goal: null })
    expect((await app.request('/')).status).toBe(400)
    expect(service.getLatest).toHaveBeenCalledWith('ses_goal')
  })

  it('creates a goal in the directory OpenCode reports for the session', async () => {
    sessionGet.mockResolvedValue({ id: 'ses_goal', location: { directory: '/repos/app' } })
    service.startFromRunningTurn.mockResolvedValue(goal())

    const response = await post('/', { sessionId: 'ses_goal', objective: 'Ship it' })

    expect(response.status).toBe(201)
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: 'ses_goal' })
    expect(service.startFromRunningTurn).toHaveBeenCalledWith({ sessionId: 'ses_goal', directory: '/repos/app', objective: 'Ship it' })
  })

  it('surfaces goal service refusals with their status and rejects unknown fields', async () => {
    sessionGet.mockResolvedValue({ id: 'ses_goal', location: { directory: '/repos/app' } })
    service.startFromRunningTurn.mockRejectedValue(new SessionGoalError('This session already has an open goal', 409))

    const conflict = await post('/', { sessionId: 'ses_goal', objective: 'Ship it' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'This session already has an open goal' })

    expect((await post('/', { sessionId: 'ses_goal', objective: 'x', directory: '/elsewhere' })).status).toBe(400)
    expect(service.startFromRunningTurn).toHaveBeenCalledTimes(1)
  })

  it('pauses an active goal and resumes a paused one', async () => {
    service.getLatest.mockReturnValueOnce(goal()).mockReturnValueOnce(goal({ status: 'paused' }))
    service.pause.mockReturnValue(goal({ status: 'paused' }))
    service.resume.mockReturnValue(goal())

    expect(await (await post('/update', { sessionId: 'ses_goal', status: 'paused' })).json()).toEqual({
      goal: goal({ status: 'paused' }),
    })
    expect(await (await post('/update', { sessionId: 'ses_goal', status: 'active' })).json()).toEqual({ goal: goal() })
    expect(service.pause).toHaveBeenCalledWith(7)
    expect(service.resume).toHaveBeenCalledWith(7)
  })

  it('answers a completion report without changing the goal, leaving the decision to the audit', async () => {
    service.getLatest.mockReturnValue(goal())

    const body = (await (await post('/update', { sessionId: 'ses_goal', status: 'complete' })).json()) as {
      goal: SessionGoal
      note: string
    }

    expect(body.goal).toEqual(goal())
    expect(body.note).toContain('independent goal audit')
    expect(service.pause).not.toHaveBeenCalled()
    expect(service.resume).not.toHaveBeenCalled()
  })

  it('refuses a completion report for a paused goal, which no audit would follow', async () => {
    service.getLatest.mockReturnValue(goal({ status: 'paused' }))

    expect((await post('/update', { sessionId: 'ses_goal', status: 'complete' })).status).toBe(409)
    expect(service.resume).not.toHaveBeenCalled()
  })

  it('rejects objective changes and updates without an open goal', async () => {
    expect((await post('/update', { sessionId: 'ses_goal', objective: 'New aim' })).status).toBe(400)
    service.getLatest.mockReturnValue(goal({ status: 'completed' }))
    expect((await post('/update', { sessionId: 'ses_goal', status: 'paused' })).status).toBe(404)
    service.getLatest.mockReturnValue(null)
    expect((await post('/update', { sessionId: 'ses_goal', status: 'active' })).status).toBe(404)
  })
})
