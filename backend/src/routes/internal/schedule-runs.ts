import { Hono } from 'hono'
import { z } from 'zod'
import { ScheduleOutcomeReportInputSchema } from '@opencode-manager/shared/schemas'
import { ScheduleServiceError, type ScheduleService } from '../../services/schedules'
import { handleServiceError } from '../../utils/route-helpers'

const OutcomeRequestSchema = ScheduleOutcomeReportInputSchema.extend({
  sessionID: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  agent: z.string().nullable().optional(),
})

/** Accepts the outcome a scheduled session reports through the `ocm` tool. */
export function createInternalScheduleRunRoutes(scheduleService: ScheduleService) {
  const app = new Hono()
  app.post('/outcome', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    const parsed = OutcomeRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
    }
    const { sessionID, agent, ...input } = parsed.data
    try {
      return c.json(scheduleService.reportOutcome(sessionID, input, agent ?? null))
    } catch (error) {
      return handleServiceError(c, error, 'Failed to report schedule run outcome', ScheduleServiceError)
    }
  })
  return app
}
