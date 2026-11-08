import { Hono } from 'hono'
import { z } from 'zod'
import { SetCredentialRequestSchema } from '../../../shared/src/schemas/auth'
import { ProviderAccountRenameRequestSchema } from '@opencode-manager/shared/schemas'
import { providerRateLimitStore } from '../services/provider-rate-limit-store'
import { logger } from '../utils/logger'
import { handleOpenCodeError } from '../utils/route-helpers'
import {
  addRecentModel,
  removeRecentModel,
  setModelVariant,
  toggleFavoriteModel,
  type IntegrationInfo,
} from '@opencode-manager/shared/opencode'
import type { OpenCodeClient } from '../services/opencode/client'
import { runWhenIntegrationReady } from '../services/opencode/integration-ready'
import { createProviderExternalRoutes } from './provider-external'
import {
  ModelSelectionSchema,
  readOpenCodeModelState,
  updateOpenCodeModelState,
} from '../services/opencode-model-state'

const ModelStateUpdateSchema = z
  .object({
    recent: ModelSelectionSchema.optional(),
    favorite: ModelSelectionSchema.optional(),
    removeRecent: ModelSelectionSchema.optional(),
    variant: z
      .object({
        model: ModelSelectionSchema,
        value: z.string().min(1).nullable().optional(),
      })
      .optional(),
  })
  .strict()

function credentialConnections(integration: IntegrationInfo) {
  return integration.connections.filter((connection) => connection.type === 'credential')
}

export function createProvidersRoutes(openCodeClient: OpenCodeClient) {
  const app = new Hono()
  app.route('/', createProviderExternalRoutes(openCodeClient))
  app.get('/:id/rate-limits', (c) =>
    c.json({
      observations: providerRateLimitStore.list(c.req.param('id')),
      persistence: 'memory',
    }),
  )

  app.get('/model-state', async (c) => {
    try {
      const state = await readOpenCodeModelState()
      return c.json(state)
    } catch (error) {
      logger.error('Failed to read OpenCode model state:', error)
      return c.json({ recent: [], favorite: [], variant: {} })
    }
  })

  app.post('/model-state', async (c) => {
    try {
      const body = await c.req.json()
      const validated = ModelStateUpdateSchema.parse(body)

      const nextState = await updateOpenCodeModelState((state) => {
        if (validated.favorite) {
          return toggleFavoriteModel(state, validated.favorite)
        }
        if (validated.recent) {
          return addRecentModel(state, validated.recent)
        }
        if (validated.removeRecent) {
          return removeRecentModel(state, validated.removeRecent)
        }
        if (validated.variant) {
          return setModelVariant(state, validated.variant.model, validated.variant.value ?? undefined)
        }
        return state
      })

      return c.json(nextState)
    } catch (error) {
      logger.error('Failed to update OpenCode model state:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to update OpenCode model state' }, 500)
    }
  })

  app.get('/credentials', async (c) => {
    try {
      const integrations = await openCodeClient.api.integration.list()
      const providers = integrations.data
        .filter((integration) => credentialConnections(integration).length > 0)
        .map((integration) => integration.id)
      return c.json({ providers })
    } catch (error) {
      return handleOpenCodeError(c, error, 'Failed to list provider credentials')
    }
  })

  app.get('/:id/accounts', async (c) => {
    try {
      const integrationID = c.req.param('id')
      const credentials = await openCodeClient.api.credential.list()
      const accounts = credentials
        .filter((entry) => entry.integrationID === integrationID)
        .map((entry) => ({
          id: entry.id,
          integrationID: entry.integrationID,
          label: entry.label,
          active: entry.active,
          type: entry.value.type,
          methodID: entry.value.type === 'key' ? null : entry.value.methodID,
        }))
      return c.json({ accounts })
    } catch {
      logger.warn('Could not load provider account summaries')
      return c.json(
        {
          error: 'Could not load provider accounts',
          code: 'ACCOUNTS_UNAVAILABLE',
        },
        502,
      )
    }
  })

  app.get('/:id/credentials/status', async (c) => {
    try {
      const integrationID = c.req.param('id')
      const integration = await runWhenIntegrationReady(openCodeClient.api, { integrationID }, () =>
        openCodeClient.api.integration.get({ integrationID }),
      )
      return c.json({
        hasCredentials: credentialConnections(integration.data).length > 0,
      })
    } catch (error) {
      return handleOpenCodeError(c, error, 'Failed to check credential status')
    }
  })

  app.post('/:id/accounts/:accountId/activate', async (c) => {
    try {
      const integrationID = c.req.param('id')
      const credentialID = c.req.param('accountId')
      const before = await openCodeClient.api.credential.list()
      if (!before.some((entry) => entry.id === credentialID && entry.integrationID === integrationID)) {
        return c.json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' }, 404)
      }
      await openCodeClient.api.credential.activate({ credentialID })
      const after = await openCodeClient.api.credential.list()
      const selected = after.filter((entry) => entry.integrationID === integrationID && entry.active)
      const othersPreserved = before
        .filter((entry) => entry.integrationID !== integrationID)
        .every((entry) =>
          after.some(
            (current) =>
              current.id === entry.id &&
              current.integrationID === entry.integrationID &&
              current.active === entry.active,
          ),
        )
      if (selected.length !== 1 || selected[0]?.id !== credentialID || !othersPreserved) {
        return c.json(
          {
            error: 'Account activation could not be confirmed',
            code: 'ACCOUNT_ACTIVATION_UNCONFIRMED',
          },
          409,
        )
      }
      return c.json({ success: true, activeAccountId: credentialID })
    } catch {
      logger.warn('Could not activate provider account')
      return c.json(
        {
          error: 'Could not activate provider account',
          code: 'ACCOUNT_ACTIVATION_FAILED',
        },
        502,
      )
    }
  })

  app.patch('/:id/accounts/:accountId', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid account name', code: 'INVALID_ACCOUNT_NAME' }, 400)
    }
    const parsed = ProviderAccountRenameRequestSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Invalid account name', code: 'INVALID_ACCOUNT_NAME' }, 400)
    try {
      const integrationID = c.req.param('id')
      const credentialID = c.req.param('accountId')
      const before = await openCodeClient.api.credential.list()
      const previous = before.find((entry) => entry.id === credentialID && entry.integrationID === integrationID)
      if (!previous) return c.json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' }, 404)
      await openCodeClient.api.credential.update({
        credentialID,
        label: parsed.data.label,
      })
      const after = await openCodeClient.api.credential.list()
      const current = after.find((entry) => entry.id === credentialID && entry.integrationID === integrationID)
      if (current?.label !== parsed.data.label || current.active !== previous.active) {
        return c.json(
          {
            error: 'Account rename could not be confirmed',
            code: 'ACCOUNT_RENAME_UNCONFIRMED',
          },
          409,
        )
      }
      return c.json({
        success: true,
        accountId: credentialID,
        label: current.label,
      })
    } catch {
      logger.warn('Could not rename provider account')
      return c.json(
        {
          error: 'Could not rename provider account',
          code: 'ACCOUNT_RENAME_FAILED',
        },
        502,
      )
    }
  })

  app.post('/:id/credentials', async (c) => {
    try {
      const body = await c.req.json()
      const validated = SetCredentialRequestSchema.parse(body)

      const integrationID = c.req.param('id')
      await runWhenIntegrationReady(openCodeClient.api, { integrationID }, () =>
        openCodeClient.api.integration.connect.key({
          integrationID,
          key: validated.apiKey,
          ...(validated.answer ? { answer: validated.answer } : {}),
        }),
      )

      return c.json({ success: true })
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request data', details: error.issues }, 400)
      }
      return handleOpenCodeError(c, error, 'Failed to set provider credentials')
    }
  })

  app.delete('/:id/credentials', async (c) => {
    try {
      const integrationID = c.req.param('id')
      const integration = await runWhenIntegrationReady(openCodeClient.api, { integrationID }, () =>
        openCodeClient.api.integration.get({ integrationID }),
      )

      for (const connection of credentialConnections(integration.data)) {
        await openCodeClient.api.credential.remove({
          credentialID: connection.id,
        })
      }

      return c.json({ success: true })
    } catch (error) {
      return handleOpenCodeError(c, error, 'Failed to delete provider credentials')
    }
  })

  app.delete('/:id/accounts/:accountId', async (c) => {
    try {
      const integrationID = c.req.param('id')
      const credentialID = c.req.param('accountId')
      const before = await openCodeClient.api.credential.list()
      if (!before.some((entry) => entry.id === credentialID && entry.integrationID === integrationID)) {
        return c.json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' }, 404)
      }
      await openCodeClient.api.credential.remove({ credentialID })
      const after = await openCodeClient.api.credential.list()
      const othersPreserved = before
        .filter((entry) => entry.id !== credentialID)
        .every((entry) =>
          after.some(
            (current) =>
              current.id === entry.id && current.integrationID === entry.integrationID && current.label === entry.label,
          ),
        )
      if (after.some((entry) => entry.id === credentialID) || !othersPreserved) {
        return c.json(
          {
            error: 'Account deletion could not be confirmed',
            code: 'ACCOUNT_DELETION_UNCONFIRMED',
          },
          409,
        )
      }
      return c.json({ success: true, deletedAccountId: credentialID })
    } catch {
      logger.warn('Could not delete provider account')
      return c.json(
        {
          error: 'Could not delete provider account',
          code: 'ACCOUNT_DELETION_FAILED',
        },
        502,
      )
    }
  })

  return app
}
