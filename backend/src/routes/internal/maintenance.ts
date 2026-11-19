import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { z } from 'zod'
import { getMaintenanceStatus } from '../../services/maintenance-status'
import { maintenanceAdmission } from '../../services/maintenance-admission'
import type { OpenCodeClient } from '../../services/opencode/client'

/** Serves restart and deployment readiness to internal-token holders. */
export function createMaintenanceRoutes(db: Database, client: Pick<OpenCodeClient, 'api'>) {
  const app = new Hono()
  const ownerSchema = z.object({ nonce: z.string().uuid() }).strict()
  for (const action of ['enter', 'seal', 'exit'] as const) {
    app.post(`/${action}`, async (c) => {
      c.header('Cache-Control', 'no-store')
      const parsed = ownerSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'A UUID maintenance nonce is required' }, 400)
      if (!maintenanceAdmission[action](parsed.data.nonce))
        return c.json({ error: 'Maintenance ownership conflict' }, 409)
      return c.json({ admission: maintenanceAdmission.status() })
    })
  }
  app.get('/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await getMaintenanceStatus(db, client))
  })
  return app
}
