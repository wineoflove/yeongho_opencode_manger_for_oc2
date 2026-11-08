import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Database } from 'bun:sqlite'
import { isAbsolute } from 'path'
import { z } from 'zod'
import { InternalCloneRepoRequestSchema, UpdateRepoRequestSchema } from '@opencode-manager/shared/schemas'
import type { SettingsService } from '../../services/settings'
import type { GitAuthService } from '../../services/git-auth'
import { getRepoById, listRepos, updateRepoName } from '../../db/queries'
import { cloneRepo, initLocalRepo } from '../../services/repo'
import { logger } from '../../utils/logger'
import { getErrorMessage, getStatusCode } from '../../utils/error-utils'

/** Rejects HTTP(S) clone URLs that embed credentials, a query or a fragment; Manager's stored credentials are used instead. */
function hasEmbeddedSecret(repoUrl: string): boolean {
  if (!/^https?:\/\//i.test(repoUrl)) return false
  try {
    const url = new URL(repoUrl)
    return Boolean(url.username || url.password || url.search || url.hash)
  } catch {
    return true
  }
}

const InternalRepoRequestSchema = z.union([
  InternalCloneRepoRequestSchema.refine((input) => !hasEmbeddedSecret(input.repoUrl), {
    message: 'Repository URLs must not contain credentials, a query or a fragment',
  }),
  z.object({ localPath: z.string().trim().min(1).refine(isAbsolute, 'localPath must be absolute') }).strict(),
])

export function createInternalRepoRoutes(db: Database, settingsService: SettingsService, gitAuthService: GitAuthService) {
  const app = new Hono()

  app.get('/', (c) => {
    try {
      const settings = settingsService.getSettings()
      const repos = listRepos(db, settings.preferences.repoOrder)
      return c.json({ repos })
    } catch (error) {
      logger.error('Failed to list internal repos:', error)
      return c.json({ error: getErrorMessage(error) }, 500)
    }
  })

  app.post('/', async (c) => {
    const parsed = InternalRepoRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
    }
    try {
      if ('localPath' in parsed.data) {
        return c.json(await initLocalRepo(db, gitAuthService, parsed.data.localPath))
      }
      const { repoUrl, branch, directoryName } = parsed.data
      const repo = await cloneRepo(db, gitAuthService, repoUrl, { branch, directoryName })
      return c.json(repo)
    } catch (error) {
      logger.error('Failed to clone internal repo:', error)
      return c.json({ error: getErrorMessage(error) }, getStatusCode(error) as ContentfulStatusCode)
    }
  })

  app.patch('/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = Number(rawId)
    if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid repository id; the assistant repository cannot be renamed' }, 400)
    }
    const parsed = UpdateRepoRequestSchema.strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid rename request' }, 400)
    const repo = getRepoById(db, id)
    if (!repo) return c.json({ error: 'Repo not found' }, 404)
    const name = parsed.data.name || null
    updateRepoName(db, id, name)
    return c.json({ ...repo, name: name ?? undefined })
  })

  return app
}
