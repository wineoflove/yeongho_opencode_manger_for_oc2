import { expect, it } from 'bun:test'
import { writeFile, utimes } from 'node:fs/promises'
import { fixture, addEntry, decision } from './application-fixtures.mjs'
import { readArtifact, readBounded, sha256 } from './application-files.mjs'
import { prepareApplications } from './application-plan.mjs'
import { recordApplication } from './application-store.mjs'
import { recordPolicyReview } from './policy-review.mjs'
import { verifyReadback } from './application-verification.mjs'
import { collect } from './data.mjs'
import { validateAnalysis } from './contracts.mjs'

async function reviewInput(f) {
  const plan = await prepareApplications(f.config, 'weekly')
  const manifest = JSON.parse(await readArtifact(f.config, plan.manifest))
  return {
    manifest: plan.manifest,
    decisions: manifest.policies.flatMap((policy) =>
      policy.sections.map((section) => ({
        sectionId: section.id,
        decision: 'keep',
        reason: 'scope remains valid',
        evidence: [plan.manifest],
      })),
    ),
  }
}

it('collects all older policies and more than thirty learning records without truncating Limits', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 35; index++) await addEntry(f.config, `entry${index}`, `test.entry${index}`)
    await utimes(f.policy, new Date('2020-01-01'), new Date('2020-01-01'))
    const batch = await collect({ store: f.store }, 'weekly', null, Date.now())
    expect(batch.coverage).toMatchObject({ learningRecords: 36, policyFiles: 1 })
    expect(batch.records.filter((record) => record.kind === 'current-instruction')).toHaveLength(3)
    expect(batch.records.find((record) => record.id === 'entry/first').limits).toBe('No deployment evidence.')
    const first = batch.contentDigest
    await writeFile(f.policy, (await readBounded(f.policy)).replace('focused checks', 'targeted checks'))
    expect((await collect({ store: f.store }, 'weekly', null, Date.now())).contentDigest).not.toBe(first)
  } finally {
    await f.close()
  }
})

it('cannot finish a full weekly review when any section is missing', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    await expect(recordPolicyReview(f.config, { ...input, decisions: input.decisions.slice(1) })).rejects.toThrow(
      'INCOMPLETE_POLICY_COVERAGE',
    )
    const result = await recordPolicyReview(f.config, input)
    expect(result).toMatchObject({ status: 'reviewed', files: 1, sections: 3, deferred: 0 })
  } finally {
    await f.close()
  }
})

it('records deferred sections as partial rather than full completion', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    input.decisions[0].decision = 'defer'
    expect(await recordPolicyReview(f.config, input)).toMatchObject({ status: 'partial', deferred: 1 })
  } finally {
    await f.close()
  }
})

it('requires an applied change event and exact hashes for instruction removal', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    const application = await decision(f)
    const original = await readBounded(f.policy)
    const next = original.replace('## Work\nUse focused checks.\n', '')
    await writeFile(f.policy, next)
    const readback = await verifyReadback(f.config, f.policy, 'removed obsolete section')
    application.targets[0] = { ...application.targets[0], afterHash: sha256(next), change: 'modified' }
    application.checks = [
      {
        kind: readback.kind,
        command: readback.command,
        cwd: readback.cwd,
        scope: readback.scope,
        evidence: readback.evidence,
        exitCode: 0,
      },
    ]
    const manifest = JSON.parse(await readArtifact(f.config, input.manifest))
    const work = manifest.policies[0].sections.find((section) => section.heading === 'Work')
    input.decisions.find((item) => item.sectionId === work.id).decision = 'remove'
    await expect(recordPolicyReview(f.config, input)).rejects.toThrow('POLICY_CHANGE_WITHOUT_APPLICATION')
    const event = await recordApplication(f.config, application)
    input.decisions.find((item) => item.sectionId === work.id).applicationEvent = event.artifact
    expect((await recordPolicyReview(f.config, input)).status).toBe('reviewed')
  } finally {
    await f.close()
  }
})

it('refuses policy drift after review and invented analysis source IDs', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    await writeFile(f.policy, (await readBounded(f.policy)).replace('focused', 'different'))
    await expect(recordPolicyReview(f.config, input)).rejects.toThrow('UNREVIEWED_POLICY_CHANGE')
    const analysis = validateAnalysis(
      {
        summary: '',
        recurring: [],
        uncertainties: [],
        suggestions: [],
        lessons: [],
        policyFindings: [{ sourceId: 'fake', action: 'remove', reason: 'old' }],
      },
      [],
    )
    expect(analysis.policyFindings).toEqual([])
    expect(analysis.adjustments.join('\n')).toContain('fake')
  } finally {
    await f.close()
  }
})

it('requires a file-level application even when only section order changes', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    const application = await decision(f)
    const next = '# Assistant\n\n## Work\nUse focused checks.\n\n## Safety\nKeep approval boundaries.\n'
    await writeFile(f.policy, next)
    await expect(recordPolicyReview(f.config, input)).rejects.toThrow('POLICY_CHANGE_WITHOUT_APPLICATION')
    const readback = await verifyReadback(f.config, f.policy, 'reviewed section reordering')
    application.targets[0] = { ...application.targets[0], afterHash: sha256(next), change: 'modified' }
    application.checks = [
      {
        kind: readback.kind,
        command: readback.command,
        cwd: readback.cwd,
        scope: readback.scope,
        evidence: readback.evidence,
        exitCode: 0,
      },
    ]
    const event = await recordApplication(f.config, application)
    input.decisions[0].applicationEvent = event.artifact
    expect((await recordPolicyReview(f.config, input)).status).toBe('reviewed')
  } finally {
    await f.close()
  }
})

it('retains valid prior change evidence after a later existing-state reconciliation', async () => {
  const f = await fixture()
  try {
    const input = await reviewInput(f)
    const application = await decision(f)
    const next = (await readBounded(f.policy)).replace('Use focused checks.', 'Use scoped checks.')
    await writeFile(f.policy, next)
    const readback = await verifyReadback(f.config, f.policy, 'updated check scope')
    application.targets[0] = { ...application.targets[0], afterHash: sha256(next), change: 'modified' }
    application.checks = [
      {
        kind: readback.kind,
        command: readback.command,
        cwd: readback.cwd,
        scope: readback.scope,
        evidence: readback.evidence,
        exitCode: 0,
      },
    ]
    const changed = await recordApplication(f.config, application)
    await recordApplication(f.config, await decision(f, { expectedRevision: 1 }))
    const manifest = JSON.parse(await readArtifact(f.config, input.manifest))
    const work = manifest.policies[0].sections.find((section) => section.heading === 'Work')
    Object.assign(
      input.decisions.find((item) => item.sectionId === work.id),
      { decision: 'change', applicationEvent: changed.artifact },
    )
    expect((await recordPolicyReview(f.config, input)).status).toBe('reviewed')
  } finally {
    await f.close()
  }
})
