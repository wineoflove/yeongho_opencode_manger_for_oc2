import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSystemRoutes } from '../../src/routes/system'
import { SystemStatusService } from '../../src/services/system-status'
import { SystemStatusResponseSchema } from '@opencode-manager/shared/schemas'
import { createAuthMiddleware } from '../../src/auth/middleware'
import { createAuth } from '../../src/auth'
import { Database } from 'bun:sqlite'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { createInternalTestApp } from '../helpers/internal-test-app'

const service = () =>
  new SystemStatusService({
    platform: 'win32',
    os: { cpus: () => [], loadavg: () => [], totalmem: () => 0 },
    run: async () => '',
    readFile: async () => '',
  })

describe('system routes', () => {
  it('returns a parsed status response', async () => {
    const response = await createSystemRoutes(service()).request('/status')
    expect(response.status).toBe(200)
    expect(SystemStatusResponseSchema.parse(await response.json()).platform).toBe('other')
  })

  it('returns only a stable error code for invalid output', async () => {
    const source = service()
    const status = await source.getStatus()
    vi.spyOn(source, 'getStatus').mockResolvedValue({ ...status, collectedAt: Number.NaN })
    const response = await createSystemRoutes(source).request('/status')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'SYSTEM_STATUS_INVALID' })
  })

  it('rejects unauthenticated public status requests before collecting', async () => {
    const db = new Database(':memory:')
    migrate(db, allMigrations)
    const auth = createAuth(db)
    vi.spyOn(auth.api, 'getSession').mockResolvedValue(null)
    const source = service()
    const collect = vi.spyOn(source, 'getStatus')
    const app = new Hono()
    app.use('/api/*', createAuthMiddleware(auth))
    app.route('/api/system', createSystemRoutes(source))
    const response = await app.request('/api/system/status')
    expect(response.status).toBe(401)
    expect(collect).not.toHaveBeenCalled()
    db.close()
  })

  it('mounts the injected service behind internal bearer authentication and shares public cache', async () => {
    const db = new Database(':memory:')
    migrate(db, allMigrations)
    const run = vi.fn(async () => '')
    const source = new SystemStatusService({
      platform: 'linux',
      os: { cpus: () => [], loadavg: () => [], totalmem: () => 0 },
      run,
      readFile: async () => '',
      now: () => 1,
    })
    const app = new Hono()
    app.route('/api/internal', createInternalTestApp(db, { systemStatusService: source }))
    app.route('/api/system', createSystemRoutes(source))
    const denied = await app.request('/api/internal/system/status')
    expect(denied.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
    const internal = await app.request('/api/internal/system/status', {
      headers: { authorization: `Bearer ${getOrCreateInternalToken(db)}` },
    })
    const publicResponse = await app.request('/api/system/status')
    expect(internal.status).toBe(200)
    expect(await internal.json()).toEqual(await publicResponse.json())
    expect(run).toHaveBeenCalledTimes(1)
    db.close()
  })
})
