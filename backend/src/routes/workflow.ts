import { Hono } from 'hono'
import {
  WorkflowRangeSchema,
  WorkflowSessionTimelineSchema,
  WorkflowStatsResponseSchema,
} from '@opencode-manager/shared/schemas'
import {
  WorkflowSessionIdError,
  WorkflowSourceIncompatibleError,
  type WorkflowStatsSource,
} from '../services/stats/workflow-source'
import { logger } from '../utils/logger'

export function createWorkflowRoutes(source: Pick<WorkflowStatsSource, 'getStats' | 'getSessionTimeline'>) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof WorkflowSourceIncompatibleError) return c.json({ error: 'WORKFLOW_SOURCE_INCOMPATIBLE' }, 503)
    if (error instanceof WorkflowSessionIdError) return c.json({ error: 'WORKFLOW_SESSION_INVALID_ID' }, 400)
    logger.error('Workflow request failed', error)
    return c.json({ error: 'WORKFLOW_STATS_FAILED' }, 500)
  })
  app.get('/', async (c) => {
    const range = WorkflowRangeSchema.safeParse(c.req.query('range') ?? '7d')
    if (!range.success) return c.json({ error: 'WORKFLOW_INVALID_RANGE' }, 400)
    return c.json(WorkflowStatsResponseSchema.parse(await source.getStats(range.data)))
  })
  app.get('/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    if (!/^ses_[A-Za-z0-9]{10,40}$/.test(sessionId)) return c.json({ error: 'WORKFLOW_SESSION_INVALID_ID' }, 400)
    const timeline = await source.getSessionTimeline(sessionId)
    if (!timeline) return c.json({ error: 'WORKFLOW_SESSION_NOT_FOUND' }, 404)
    return c.json(WorkflowSessionTimelineSchema.parse(timeline))
  })
  return app
}
