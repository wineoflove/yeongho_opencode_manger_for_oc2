import { Hono } from 'hono'
import {
  AgentGoalCreateRequestSchema,
  AgentGoalUpdateRequestSchema,
  type SessionGoal,
} from '@opencode-manager/shared/schemas'
import type { OpenCodeClient } from '../../services/opencode/client'
import { SessionGoalError, type SessionGoalService } from '../../services/session-goals'
import { handleServiceError, parseJsonBody } from '../../utils/route-helpers'

const COMPLETION_NOTE =
  'This call does not complete the goal. The independent goal audit decides completion when this turn ends; the goal stays active until the audit confirms it.'

/**
 * Goal operations for the agent-facing get_goal, create_goal and update_goal tools. Each request is
 * scoped to the calling session; the directory is read from OpenCode instead of trusted from the agent.
 */
export function createInternalAgentGoalRoutes(service: SessionGoalService, openCodeClient: OpenCodeClient) {
  const app = new Hono()

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId')
    if (!sessionId) return c.json({ error: 'Invalid request' }, 400)
    return c.json({ goal: service.getLatest(sessionId) })
  })

  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, AgentGoalCreateRequestSchema)
    if (!parsed.ok) return parsed.response
    try {
      const session = await openCodeClient.api.session.get({ sessionID: parsed.data.sessionId })
      const goal = await service.startFromRunningTurn({
        sessionId: parsed.data.sessionId,
        directory: session.location.directory,
        objective: parsed.data.objective,
      })
      return c.json({ goal }, 201)
    } catch (error) {
      return handleServiceError(c, error, 'Failed to create session goal', SessionGoalError)
    }
  })

  app.post('/update', async (c) => {
    const parsed = await parseJsonBody(c, AgentGoalUpdateRequestSchema)
    if (!parsed.ok) return parsed.response
    const { sessionId, status, objective } = parsed.data
    if (objective !== undefined) {
      return c.json(
        {
          error:
            'Changing a goal objective is not supported. Finish the current goal through the audit, or ask the user to cancel it, before creating a new one.',
        },
        400,
      )
    }
    const current = service.getLatest(sessionId)
    if (!current || (current.status !== 'active' && current.status !== 'paused')) {
      return c.json({ error: 'This session has no open goal' }, 404)
    }
    if (status === 'complete' && current.status === 'paused') {
      return c.json({ error: 'The goal is paused; resume it so the audit can confirm completion.' }, 409)
    }
    try {
      const goal: SessionGoal =
        status === 'paused' && current.status === 'active'
          ? service.pause(current.id)
          : status === 'active' && current.status === 'paused'
            ? service.resume(current.id)
            : current
      return c.json(status === 'complete' ? { goal, note: COMPLETION_NOTE } : { goal })
    } catch (error) {
      return handleServiceError(c, error, 'Failed to update session goal', SessionGoalError)
    }
  })

  return app
}
