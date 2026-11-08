import { Hono } from 'hono'
import { isIntegrationNotFoundError, type IntegrationInfo } from '@opencode-manager/shared/opencode'
import {
  ProviderExternalLoginRequestSchema,
  ProviderExternalLoginResponseSchema,
} from '@opencode-manager/shared/schemas'
import type { OpenCodeClient } from '../services/opencode/client'
import { runWhenIntegrationReady } from '../services/opencode/integration-ready'
import { logger } from '../utils/logger'

const target = { integrationID: 'claude-agent' } as const
const methodID = 'claude-login'

function externalConnections(integration: IntegrationInfo) {
  return integration.connections.filter((entry) => entry.type === 'credential' && entry.method === 'external')
}

function responseState(integration: IntegrationInfo | undefined) {
  const available = integration?.methods.some((method) => method.type === 'external' && method.id === methodID) ?? false
  const connections = integration ? externalConnections(integration) : []
  const status = !available
    ? 'unavailable'
    : connections.length === 0
      ? 'unconnected'
      : connections.some((connection) => connection.status?.status === 'needs_auth')
        ? 'needs_auth'
        : 'connected'
  return ProviderExternalLoginResponseSchema.parse({
    ...target,
    methodID,
    available,
    status,
    connectionScope: 'current_host_login',
    supportsMultipleAccounts: false,
    instructions: {
      command: 'claude auth login',
      location: 'opencode_host',
      message:
        'Run claude auth login with the official Claude Code CLI on the OpenCode host as the user running OpenCode. This connection references the current Claude Code login, not an isolated account. Native connection status does not verify successful inference.',
    },
  })
}

export function createProviderExternalRoutes(client: OpenCodeClient) {
  const app = new Hono()
  let pending: Promise<ReturnType<typeof responseState>> | undefined

  async function readIntegration() {
    try {
      const result = await runWhenIntegrationReady(client.api, target, () => client.api.integration.get(target))
      return result.data
    } catch (error) {
      if (isIntegrationNotFoundError(error)) return undefined
      throw error
    }
  }

  async function connect() {
    const integration = await readIntegration()
    const state = responseState(integration)
    if (!integration || !state.available || externalConnections(integration).length > 0) return state
    await runWhenIntegrationReady(client.api, target, () =>
      client.api.integration.connect.external({ ...target, methodID }),
    )
    return responseState(await readIntegration())
  }

  app.get('/claude-agent/external-login', async (c) => {
    try {
      return c.json(responseState(await readIntegration()))
    } catch {
      logger.warn('Could not read Claude Code external connection')
      return c.json(
        {
          error: 'Could not read external connection',
          code: 'EXTERNAL_LOGIN_UNAVAILABLE',
        },
        502,
      )
    }
  })

  app.post('/claude-agent/external-login', async (c) => {
    try {
      const text = await c.req.text()
      const body: unknown = text.length === 0 ? {} : JSON.parse(text)
      if (!ProviderExternalLoginRequestSchema.safeParse(body).success) {
        return c.json({ error: 'Invalid request', code: 'INVALID_EXTERNAL_LOGIN_REQUEST' }, 400)
      }
    } catch {
      return c.json({ error: 'Invalid request', code: 'INVALID_EXTERNAL_LOGIN_REQUEST' }, 400)
    }
    try {
      const operation = pending ?? connect()
      pending = operation
      try {
        const state = await operation
        return c.json(state, state.available ? 200 : 409)
      } finally {
        if (pending === operation) pending = undefined
      }
    } catch {
      logger.warn('Could not register Claude Code external connection')
      return c.json(
        {
          error: 'Could not register external connection',
          code: 'EXTERNAL_LOGIN_FAILED',
        },
        502,
      )
    }
  })

  return app
}
