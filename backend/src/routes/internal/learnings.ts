import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { LearningRecordInputSchema, LearningSearchInputSchema } from '@opencode-manager/shared/schemas'
import { getLearningsEntriesPath } from '@opencode-manager/shared/config/env'
import type { OpenCodeClient } from '../../services/opencode/client'
import { isScheduleRunSession } from '../../db/schedules'
import {
  runLearningScript,
  type LearningScriptResult,
  type LearningScriptRunner,
} from '../../services/learnings/script-runner'

const LearningRecordRequestSchema = LearningRecordInputSchema.extend({
  sessionID: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  agent: z.string().nullable().optional(),
})

const ScriptErrorSchema = z.object({ error: z.string() })

function scriptErrorCode(result: LearningScriptResult, fallback: string): string {
  const line = result.stderr.trim().split('\n').at(-1) ?? ''
  try {
    return ScriptErrorSchema.parse(JSON.parse(line)).error
  } catch {
    return fallback
  }
}

function jsonPassthrough(c: Context, stdout: string, status: 200 | 201) {
  return c.body(stdout, status, { 'content-type': 'application/json; charset=utf-8' })
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/** Returns the session parent, or null when OpenCode cannot resolve the session. */
async function lookupParentSession(
  openCodeClient: OpenCodeClient,
  sessionID: string,
): Promise<{ parentID: string | null } | null> {
  try {
    const session = await openCodeClient.api.session.get({ sessionID })
    return { parentID: session.parentID ?? null }
  } catch {
    return null
  }
}

/** Serves the learning-store lint report to authenticated Manager users. */
export function createLearningLintRoutes(runner: LearningScriptRunner = runLearningScript) {
  const app = new Hono()
  app.get('/lint', async (c) => {
    const result = await runner({ script: 'lint.mjs', args: ['--entries', getLearningsEntriesPath()] })
    if (result.timedOut) return c.json({ error: 'LEARNING_LINT_TIMEOUT' }, 504)
    if (result.exitCode !== 0) return c.json({ error: scriptErrorCode(result, 'LEARNING_LINT_FAILED') }, 500)
    return jsonPassthrough(c, result.stdout, 200)
  })
  return app
}

/** Exposes learning search and record to the `ocm` tool through the internal API. */
export function createInternalLearningRoutes(
  db: Database,
  openCodeClient: OpenCodeClient,
  runner: LearningScriptRunner = runLearningScript,
) {
  const app = new Hono()

  app.post('/search', async (c) => {
    const parsed = LearningSearchInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json({ error: 'LEARNING_SEARCH_INVALID_INPUT', details: parsed.error.issues }, 400)
    const { query, limit, maxChars, includePending } = parsed.data
    const args = [query, '--limit', String(limit), '--max-chars', String(maxChars)]
    if (includePending) args.push('--include-pending')
    args.push('--entries', getLearningsEntriesPath())
    const result = await runner({ script: 'search.mjs', args })
    if (result.timedOut) return c.json({ error: 'LEARNING_SEARCH_TIMEOUT' }, 504)
    if (result.exitCode !== 0) return c.json({ error: scriptErrorCode(result, 'LEARNING_SEARCH_FAILED') }, 400)
    return jsonPassthrough(c, result.stdout, 200)
  })

  app.post('/record', async (c) => {
    const parsed = LearningRecordRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json({ error: 'LEARNING_RECORD_INVALID_INPUT', details: parsed.error.issues }, 400)
    const { sessionID } = parsed.data
    const fields = LearningRecordInputSchema.parse(parsed.data)

    if (!isScheduleRunSession(db, sessionID)) {
      const session = await lookupParentSession(openCodeClient, sessionID)
      if (!session) return c.json({ error: 'OCM_LEARNING_RECORD_SESSION_LOOKUP_FAILED' }, 502)
      if (session.parentID) return c.json({ error: 'OCM_LEARNING_RECORD_SUBAGENT_DENIED' }, 403)
    }

    const result = await runner({
      script: 'record.mjs',
      args: ['--entries', getLearningsEntriesPath()],
      stdin: JSON.stringify(fields),
    })
    if (result.timedOut) return c.json({ error: 'LEARNING_RECORD_TIMEOUT' }, 504)
    if (result.exitCode !== 0) return c.json({ error: scriptErrorCode(result, 'LEARNING_RECORD_FAILED') }, 400)
    return jsonPassthrough(c, result.stdout, 201)
  })

  app.route('/', createLearningLintRoutes(runner))
  return app
}
