import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { snapshotOpenAiRateLimits } from './openai-rate-limit-snapshot'

type StateEntry = ReturnType<typeof snapshotOpenAiRateLimits>['entries'][number]
const rowsSchema = z.array(z.object({ key: z.string(), value: z.string() }))

export function matchesOpenAiImportedPoolState(db: Database, expected: readonly StateEntry[]): boolean {
  const rows = rowsSchema.parse(
    db
      .query(
        "SELECT key,value FROM kv WHERE key='ocm/account-pool/state/openai' OR key LIKE 'ocm/account-pool/account/openai/%' ORDER BY key",
      )
      .all(),
  )
  const wanted = expected
    .map((entry) => ({ key: entry.key, value: JSON.stringify(entry.value) }))
    .sort((a, b) => a.key.localeCompare(b.key))
  return JSON.stringify(rows) === JSON.stringify(wanted)
}
