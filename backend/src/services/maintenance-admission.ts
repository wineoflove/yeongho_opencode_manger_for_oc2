import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import type { MiddlewareHandler } from 'hono'

export class MaintenanceAdmissionError extends Error {
  readonly statusCode = 503
  constructor() {
    super('MAINTENANCE_DRAINING')
    this.name = 'MaintenanceAdmissionError'
  }
}

export class MaintenanceAdmission {
  private shuttingDown = false
  private owner: string | undefined
  private lastOwner: string | undefined
  private pendingHandlers = 0
  private revision = 0
  private sealed = false
  private readonly reopenListeners = new Set<() => void>()
  private readonly expectedParent: string | undefined
  constructor(private readonly marker?: string) {
    if (marker !== undefined && !isAbsolute(marker)) throw new MaintenanceAdmissionError()
    this.expectedParent = marker === undefined ? undefined : parentIdentity(marker)
  }
  isClosed(): boolean {
    return this.owner !== undefined || this.isExternallyClosed()
  }
  private isExternallyClosed(): boolean {
    if (this.shuttingDown) return true
    if (!this.marker) return false
    try {
      if (parentIdentity(this.marker) !== this.expectedParent) return true
      lstatSync(this.marker)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        try {
          return parentIdentity(this.marker) !== this.expectedParent
        } catch {
          return true
        }
      }
      return true
    }
  }
  assertOpen(): void {
    if (this.isClosed()) throw new MaintenanceAdmissionError()
  }
  status() {
    return {
      configured: this.marker !== undefined,
      closed: this.isClosed(),
      controlled: this.owner !== undefined,
      shuttingDown: this.shuttingDown,
      sealed: this.sealed || this.isExternallyClosed(),
      pendingHandlers: this.pendingHandlers,
      revision: this.revision,
    }
  }
  enter(owner: string): boolean {
    if (this.owner !== undefined) return this.owner === owner
    this.owner = owner
    this.sealed = false
    this.revision += 1
    return true
  }
  exit(owner: string): boolean {
    if (this.owner === undefined) return this.lastOwner === owner
    if (this.owner !== owner) return false
    this.lastOwner = owner
    this.owner = undefined
    this.sealed = false
    this.revision += 1
    if (!this.isClosed()) for (const listener of this.reopenListeners) listener()
    return true
  }
  seal(owner: string): boolean {
    if (this.owner !== owner) return false
    if (!this.sealed) this.revision += 1
    this.sealed = true
    return true
  }
  onReopen(listener: () => void): () => void {
    this.reopenListeners.add(listener)
    return () => { this.reopenListeners.delete(listener) }
  }
  admitInference(): () => void {
    if (this.sealed || this.isExternallyClosed()) throw new MaintenanceAdmissionError()
    return this.track()
  }
  admit(): () => void {
    this.assertOpen()
    return this.track()
  }
  private track(): () => void {
    this.pendingHandlers += 1
    this.revision += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingHandlers -= 1
      this.revision += 1
    }
  }
  closeForShutdown(): void {
    if (!this.shuttingDown) this.revision += 1
    this.shuttingDown = true
  }
}

function parentIdentity(marker: string): string {
  const parent = dirname(marker)
  const metadata = lstatSync(parent)
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
    throw new MaintenanceAdmissionError()
  return JSON.stringify([realpathSync(parent), metadata.dev, metadata.ino])
}

export const maintenanceAdmission = new MaintenanceAdmission(process.env.OCM_MAINTENANCE_MARKER)

export function maintenanceHttpAdmission(admission: MaintenanceAdmission): MiddlewareHandler {
  return async (c, next) => {
    const statefulRead = c.req.path === '/api/mcp-oauth-proxy/callback' ||
      c.req.path === '/api/auth' || c.req.path.startsWith('/api/auth/')
    const passiveRead =
      ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !statefulRead &&
      c.req.header('upgrade')?.toLowerCase() !== 'websocket'
    const completion =
      c.req.method === 'POST' &&
      c.req.path === '/api/internal/schedule-runs/outcome'
    const inference = c.req.method === 'POST' && c.req.path === '/api/claude-inference/v1/messages'
    const control =
      c.req.method === 'POST' &&
      ['/api/internal/maintenance/enter', '/api/internal/maintenance/seal', '/api/internal/maintenance/exit'].includes(c.req.path)
    if (passiveRead || completion || control) return await next()
    let release: () => void
    try {
      release = inference ? admission.admitInference() : admission.admit()
    } catch (error) {
      if (!(error instanceof MaintenanceAdmissionError)) throw error
      return c.json(
        {
          code: 'MAINTENANCE_DRAINING',
          error: 'Maintenance in progress. Try again later.',
        },
        503,
      )
    }
    try {
      await next()
    } finally {
      release()
    }
  }
}
