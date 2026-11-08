import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from '../../shared/src/zod.ts'
import { isAbsolute } from 'node:path'
import { DELIVERY_MODES } from '../learning-review/report-delivery.mjs'
import { publishVerified } from '../workspace-backup/lifecycle.mjs'
import { paths, readJson, writeJson } from './collect.mjs'

export const Config = z.object({
  directory: z.string().refine(isAbsolute, 'Expected an absolute path'),
  store: z.string().refine(isAbsolute, 'Expected an absolute path'),
  feedbackSession: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  delivery: z.enum(DELIVERY_MODES),
})
export const maxAgeMs = 6 * 60 * 60 * 1000
export const maxReportLength = 40000

export function freshKey(result) {
  const fresh = result.components.map((item) => [item.id, item.fresh ?? null])
  return createHash('sha256').update(JSON.stringify(fresh)).digest('hex')
}

export function messageIdFor(key, now) {
  return `msg_${((BigInt(now) << 12n) + 1n).toString(16).slice(-12)}${key.slice(0, 14)}`
}

export function reportedAfter(state, result) {
  const reported = { ...state.reported }
  for (const item of result.components) if (!item.error) reported[item.id] = item.pending.map((entry) => entry.version)
  return reported
}

export async function publishReport({ config, state, result, report, now, save, request }) {
  if (!result.hasFresh) throw new Error('No unreported versions in the collect result')
  if (now - Date.parse(result.checkedAt) > maxAgeMs) throw new Error('Collect result is stale; run collect.mjs again')
  const text = report.trim()
  if (!text || text.length > maxReportLength) throw new Error(`Report must be 1-${maxReportLength} characters`)
  const key = freshKey(result)
  const reused = state.pending?.key === key
  const pending = reused ? state.pending : { key, messageID: messageIdFor(key, now), report: text }
  await save({ ...state, pending })
  await publishVerified(config, pending.messageID, pending.report, request)
  const lastReport = {
    key,
    messageID: pending.messageID,
    session: config.feedbackSession,
    at: new Date(now).toISOString(),
  }
  await save({ reported: reportedAfter(state, result), lastReport })
  return { published: true, reusedPending: reused, ...lastReport }
}

if (import.meta.main) {
  process.umask(0o077)
  const reportPath = process.argv[2]
  if (!reportPath) {
    process.stderr.write('Usage: bun scripts/update-watch/publish.mjs <report.md>\n')
    process.exit(2)
  }
  try {
    const result = await publishReport({
      config: Config.parse(await readJson(paths.config, null)),
      state: await readJson(paths.state, { reported: {} }),
      result: await readJson(paths.latest, null),
      report: await readFile(reportPath, 'utf8'),
      now: Date.now(),
      save: (state) => writeJson(paths.state, state),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`Update report not published: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
