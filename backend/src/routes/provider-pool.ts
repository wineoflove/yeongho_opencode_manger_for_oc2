import { Hono } from 'hono'
import { z } from 'zod'
import { ProviderPoolStatusSchema, ProviderPoolConfigureSchema } from '@opencode-manager/shared/schemas'
import type { OpenCodeClient } from '../services/opencode/client'
import { logger } from '../utils/logger'
import type { SettingsService } from '../services/settings'
import { applyOpenCodeConfigUpdate } from '../services/opencode-config-apply'
import { OpenCodeConfigConflictError, readOpenCodeConfigFile } from '../services/opencode-config-file'

const nativeResponse = z.object({ data: ProviderPoolStatusSchema })
class PoolMembershipChangedError extends Error {
  constructor() {
    super('Pool membership changed before configuration write')
    this.name = 'PoolMembershipChangedError'
  }
}

export function createProviderPoolRoutes(client: OpenCodeClient, settingsService?: SettingsService) {
  const app = new Hono()
  app.put('/:id/pool', async (c) => {
    if (!settingsService)
      return c.json(
        {
          error: 'Pool configuration unavailable',
          code: 'POOL_CONFIG_UNAVAILABLE',
        },
        503,
      )
    const parsed = ProviderPoolConfigureSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'Invalid pool configuration', code: 'POOL_INVALID_CONFIG' }, 400)
    try {
      const providerID = c.req.param('id')
      const statusResponse = await client.forwardRaw(
        new Request(`http://opencode.local/api/provider/${encodeURIComponent(providerID)}/pool`),
      )
      if (statusResponse.status === 404)
        return c.json(
          {
            error: 'Account pooling is not supported',
            code: 'POOL_UNSUPPORTED',
          },
          409,
        )
      if (!statusResponse.ok) return c.json({ error: 'Account pool state unavailable', code: 'POOL_UNAVAILABLE' }, 502)
      const status = nativeResponse.parse(await statusResponse.json()).data
      const integration = await client.api.integration.get({
        integrationID: status.integrationID,
      })
      const eligible = new Set(
        integration.data.connections.flatMap((entry) =>
          entry.type === 'credential' && (entry.method === 'key' || entry.method === 'oauth') ? [entry.id] : [],
        ),
      )
      if (parsed.data.accounts.some((account) => !eligible.has(account.credentialID)))
        return c.json(
          {
            error: 'Pool account is not connected to this provider',
            code: 'POOL_ACCOUNT_MISMATCH',
          },
          409,
        )
      const credentials = (await client.api.credential.list()).filter(
        (entry) =>
          entry.integrationID === status.integrationID &&
          parsed.data.accounts.some((account) => account.credentialID === entry.id),
      )
      if (credentials.length !== parsed.data.accounts.length)
        return c.json(
          {
            error: 'Pool accounts changed before saving',
            code: 'POOL_ACCOUNT_MISMATCH',
          },
          409,
        )
      const methods = new Set(
        credentials.map((entry) => (entry.value.type === 'oauth' ? `oauth:${entry.value.methodID}` : entry.value.type)),
      )
      if (methods.size > 1)
        return c.json(
          {
            error: 'Pool accounts must use the same authentication method',
            code: 'POOL_MIXED_AUTH',
          },
          409,
        )
      const result = await applyOpenCodeConfigUpdate({
        content: {
          providers: {
            [providerID]: {
              settings: {
                accountPool: {
                  strategy: 'round-robin',
                  accounts: parsed.data.accounts,
                },
              },
            },
          },
        },
        expectedRevision: parsed.data.expectedRevision,
        mode: 'merge',
        settingsService,
        openCodeClient: client,
        beforeWrite: async () => {
          const current = await client.api.credential.list()
          for (const expected of credentials) {
            const latest = current.find(
              (entry) => entry.id === expected.id && entry.integrationID === status.integrationID,
            )
            if (
              !latest ||
              latest.value.type !== expected.value.type ||
              (latest.value.type === 'oauth' &&
                expected.value.type === 'oauth' &&
                latest.value.methodID !== expected.value.methodID)
            ) {
              throw new PoolMembershipChangedError()
            }
          }
        },
      })
      return c.json({ saved: true, applyStatus: result.status })
    } catch (error) {
      if (error instanceof OpenCodeConfigConflictError || error instanceof PoolMembershipChangedError)
        return c.json(
          {
            error: 'Configuration changed. Reload before saving.',
            code: 'POOL_CONFIG_CONFLICT',
          },
          409,
        )
      logger.warn('Account pool configuration could not be applied')
      return c.json(
        {
          error: 'Account pool configuration could not be applied',
          code: 'POOL_CONFIG_FAILED',
        },
        502,
      )
    }
  })
  app.get('/:id/pool', async (c) => {
    try {
      const provider = encodeURIComponent(c.req.param('id'))
      const response = await client.forwardRaw(new Request(`http://opencode.local/api/provider/${provider}/pool`))
      if (response.status === 404) return c.json({ supported: false })
      if (!response.ok) {
        logger.warn('Provider pool status could not be read')
        return c.json(
          {
            error: 'Could not load account pool status',
            code: 'POOL_UNAVAILABLE',
          },
          502,
        )
      }
      const parsed = nativeResponse.safeParse(await response.json())
      if (!parsed.success)
        return c.json(
          {
            error: 'Invalid account pool status',
            code: 'POOL_INVALID_RESPONSE',
          },
          502,
        )
      const config = settingsService ? await readOpenCodeConfigFile() : null
      return c.json({
        supported: true,
        status: parsed.data.data,
        ...(config?.isValid ? { configRevision: config.revision } : {}),
      })
    } catch {
      logger.warn('Provider pool status request failed')
      return c.json(
        {
          error: 'Could not load account pool status',
          code: 'POOL_UNAVAILABLE',
        },
        502,
      )
    }
  })
  return app
}
