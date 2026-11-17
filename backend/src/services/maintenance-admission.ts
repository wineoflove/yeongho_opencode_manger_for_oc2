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
  private readonly expectedParent: string | undefined
  constructor(private readonly marker?: string) {
    if (marker !== undefined && !isAbsolute(marker)) throw new MaintenanceAdmissionError()
    this.expectedParent = marker === undefined ? undefined : parentIdentity(marker)
  }
  isClosed(): boolean {
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
  status(): { readonly configured: boolean; readonly closed: boolean } {
    return { configured: this.marker !== undefined, closed: this.isClosed() }
  }
  closeForShutdown(): void {
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
    const readOnly =
      ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('upgrade')?.toLowerCase() !== 'websocket'
    const completion =
      c.req.method === 'POST' &&
      ['/api/internal/schedule-runs/outcome', '/api/claude-inference/v1/messages'].includes(c.req.path)
    if (admission.isClosed() && !readOnly && !completion)
      return c.json(
        {
          code: 'MAINTENANCE_DRAINING',
          error: 'Maintenance in progress. Try again later.',
        },
        503,
      )
    await next()
  }
}
