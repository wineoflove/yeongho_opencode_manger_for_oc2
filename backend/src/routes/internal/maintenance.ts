import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { getMaintenanceStatus } from '../../services/maintenance-status'
import type { OpenCodeClient } from '../../services/opencode/client'

/** Serves restart and deployment readiness to internal-token holders. */
export function createMaintenanceRoutes(db: Database, client: Pick<OpenCodeClient, 'api'>) {
  const app = new Hono()
  app.get('/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await getMaintenanceStatus(db, client))
  })
  return app
}
