import { PolicyReview } from './application-schema.mjs'
import { readArtifact, saveArtifact, sha256 } from './application-files.mjs'
import { policyInventory, assertProtectedPolicy, samePolicyContent } from './policy-inventory.mjs'
import { applicationEvents, latestApplications } from './application-store.mjs'

export async function recordPolicyReview(config, value) {
  const input = PolicyReview.parse(value)
  const manifest = JSON.parse(await readArtifact(config, input.manifest))
  if (manifest.mode !== 'weekly' || manifest.configDigest !== sha256(JSON.stringify(config)))
    throw new Error('WEEKLY_MANIFEST_REQUIRED')
  const originals = manifest.policies.flatMap((policy) => policy.sections.map((section) => ({ ...section, policy })))
  const decisions = new Map(input.decisions.map((decision) => [decision.sectionId, decision]))
  if (
    decisions.size !== input.decisions.length ||
    decisions.size !== originals.length ||
    originals.some((section) => !decisions.has(section.id))
  )
    throw new Error('INCOMPLETE_POLICY_COVERAGE')
  const current = await policyInventory(config)
  if (manifest.policies.length !== current.length) throw new Error('POLICY_INVENTORY_CHANGED')
  for (const before of manifest.policies) {
    const after = current.find((policy) => policy.id === before.id)
    if (!after || after.path !== before.path || sha256(before.text) !== before.sha256)
      throw new Error('POLICY_MANIFEST_MISMATCH')
    assertProtectedPolicy(after, before.text, after.text)
  }
  const events = await applicationEvents(config)
  latestApplications(events)
  const eventByArtifact = new Map(events.map((event) => [event.artifact, event]))
  const verifyChange = (artifact, policy, beforeHash) => {
    const event = eventByArtifact.get(artifact)
    if (
      !event ||
      event.input.decision !== 'applied' ||
      !event.targets.some(
        (target) =>
          target.path === policy.path &&
          target.afterHash === policy.sha256 &&
          (!beforeHash || target.beforeHash === beforeHash),
      )
    )
      throw new Error('POLICY_CHANGE_WITHOUT_APPLICATION')
  }
  for (const section of originals) {
    const decision = decisions.get(section.id)
    for (const evidence of decision.evidence) await readArtifact(config, evidence)
    const policy = current.find((item) => item.id === section.policy.id)
    const next = policy.sections.find((item) => item.id === section.id)
    if (['change', 'remove'].includes(decision.decision)) {
      if (section.protected || !policy.mutable) throw new Error('PROTECTED_POLICY_CHANGED')
      verifyChange(decision.applicationEvent, policy, section.policy.sha256)
      if (decision.decision === 'remove' ? !!next : !next || next.sha256 === section.sha256)
        throw new Error('POLICY_DISPOSITION_MISMATCH')
    } else if (!next || !samePolicyContent(next.text, section.text)) throw new Error('UNREVIEWED_POLICY_CHANGE')
  }
  for (const before of manifest.policies) {
    const after = current.find((policy) => policy.id === before.id)
    if (before.sha256 === after.sha256) continue
    const sectionIds = new Set(before.sections.map((section) => section.id))
    const references = input.decisions
      .filter((item) => sectionIds.has(item.sectionId))
      .map((item) => item.applicationEvent)
    const linked = references.find((artifact) =>
      eventByArtifact
        .get(artifact)
        ?.targets.some(
          (target) =>
            target.path === before.path && target.beforeHash === before.sha256 && target.afterHash === after.sha256,
        ),
    )
    verifyChange(linked, after, before.sha256)
  }
  const known = new Set(originals.map((section) => section.id))
  const added = current.flatMap((policy) =>
    policy.sections.filter((section) => !known.has(section.id)).map((section) => ({ section, policy })),
  )
  if (
    added.length !== input.addedSections.length ||
    new Set(input.addedSections.map((item) => item.sectionId)).size !== added.length
  )
    throw new Error('UNREVIEWED_ADDED_POLICY')
  for (const { section, policy } of added) {
    const decision = input.addedSections.find((item) => item.sectionId === section.id)
    if (!decision) throw new Error('UNREVIEWED_ADDED_POLICY')
    verifyChange(decision.applicationEvent, policy)
  }
  const deferred = input.decisions.filter((item) => item.decision === 'defer').length
  const receipt = {
    version: 1,
    recordedAt: new Date().toISOString(),
    input,
    status: deferred ? 'partial' : 'reviewed',
    files: current.length,
    sections: originals.length,
    added: added.length,
    deferred,
    after: current.map(({ path, sha256 }) => ({ path, sha256 })),
  }
  return { ...receipt, artifact: await saveArtifact(config, 'policy-reviews', receipt) }
}
