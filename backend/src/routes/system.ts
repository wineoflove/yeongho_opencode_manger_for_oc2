import { Hono } from 'hono'
import { SystemStatusResponseSchema } from '@opencode-manager/shared/schemas'
import type { SystemStatusService } from '../services/system-status'

export function createSystemRoutes(service: Pick<SystemStatusService, 'getStatus'>) {
  const app = new Hono()
  app.get('/status', async (c) => {
    try {
      return c.json(SystemStatusResponseSchema.parse(await service.getStatus()))
    } catch {
      return c.json({ error: 'SYSTEM_STATUS_INVALID' }, 500)
    }
  })
  return app
}
