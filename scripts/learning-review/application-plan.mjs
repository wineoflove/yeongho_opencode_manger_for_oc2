import { applicationInventory } from './application-store.mjs'
import { policyInventory } from './policy-inventory.mjs'
import { saveArtifact, sha256 } from './application-files.mjs'

const ACTIONABLE_PRIORITY = new Map([
  ['drifted', 0],
  ['source_changed', 1],
  ['evidence_changed', 2],
  ['unassessed', 3],
  ['planned', 4],
])

export async function prepareApplications(config, mode) {
  if (!['daily', 'weekly'].includes(mode)) throw new Error('INVALID_REVIEW_MODE')
  const inventory = await applicationInventory(config)
  const policies = await policyInventory(config)
  const actionable = inventory.items
    .filter((item) => ACTIONABLE_PRIORITY.has(item.state))
    .sort((a, b) => ACTIONABLE_PRIORITY.get(a.state) - ACTIONABLE_PRIORITY.get(b.state))
  const manifest = {
    version: 1,
    mode,
    createdAt: new Date().toISOString(),
    configDigest: sha256(JSON.stringify(config)),
    inventory,
    actionable,
    selected: actionable.slice(0, 3),
    blocked: inventory.items.filter((item) => item.state === 'blocked'),
    runtimePending: inventory.items.filter((item) => item.state === 'applied' && item.runtime === 'pending'),
    policies,
    policyDigest: sha256(JSON.stringify(policies.map(({ id, sha256 }) => ({ id, sha256 })))),
  }
  const artifact = await saveArtifact(config, 'plans', manifest)
  return {
    manifest: artifact,
    mode,
    counts: inventory.counts,
    patterns: inventory.patterns,
    selected: manifest.selected,
    actionable: actionable.length,
    blocked: manifest.blocked.length,
    runtimePending: manifest.runtimePending.length,
    policyFiles: policies.length,
    policySections: policies.reduce((sum, policy) => sum + policy.sections.length, 0),
  }
}
