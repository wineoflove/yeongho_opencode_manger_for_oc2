import { join } from 'node:path'
import { loadConfig, sha256 } from './application-files.mjs'
import { applicationEntries, applicationInventory } from './application-store.mjs'
import { policyAnalysisRecords } from './policy-inventory.mjs'

export async function collectWeekly(config, until) {
  const settings = await loadConfig(join(config.store, 'application-config.json'))
  const entries = await applicationEntries(settings)
  const policies = await policyAnalysisRecords(settings)
  const inventory = await applicationInventory(settings)
  const records = [
    ...entries.map(({ source, kind, ...entry }) => ({
      ...entry,
      learningKind: kind,
      kind: 'learning-record',
      id: `entry/${entry.id}`,
    })),
    ...policies,
    { id: 'application/inventory', kind: 'implementation-inventory', counts: inventory.counts, items: inventory.items },
  ]
  if (Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024) throw new Error('WEEKLY_INPUT_REQUIRES_PARTITION')
  return {
    records,
    cursor: null,
    more: false,
    from: null,
    through: until,
    contentDigest: sha256(JSON.stringify(records)),
    coverage: {
      learningRecords: entries.length,
      policyFiles: settings.policies.length,
      policySections: policies.length,
    },
  }
}
