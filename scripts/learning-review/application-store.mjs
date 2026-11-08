import { mkdir, opendir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from '../../shared/src/zod.ts'
import { loadEntries, sanitize } from './search-entries.mjs'
import { Decision } from './application-schema.mjs'
import { readArtifact, readBounded, saveArtifact, sha256, targetPath } from './application-files.mjs'
import { assertProtectedPolicy, policyRuleBlock } from './policy-inventory.mjs'
import { VerificationReceipt } from './application-verification.mjs'

export const canonicalKey = (config, key) => config.aliases[key] ?? key
export const sourceDigest = (entries) => sha256(JSON.stringify(entries.map(({ source, ...entry }) => entry)))

export async function applicationEntries(config) {
  const loaded = await loadEntries(join(config.store, 'entries'))
  if (Object.values(loaded.skipped).some((count) => count > 0)) throw new Error('INCOMPLETE_LEARNING_INVENTORY')
  if (new Set(loaded.entries.map((entry) => entry.id)).size !== loaded.entries.length)
    throw new Error('DUPLICATE_ENTRY_ID')
  return loaded.entries
}

export async function applicationEvents(config) {
  const events = []
  let directory
  try {
    directory = await opendir(join(config.store, 'applications', 'events'))
  } catch (error) {
    if (error.code === 'ENOENT') return events
    throw error
  }
  for await (const file of directory) {
    if (!file.name.endsWith('.json')) continue
    if (!file.isFile() || events.length >= 10000) throw new Error('UNSAFE_EVENT_INVENTORY')
    const artifact = `applications/events/${file.name}`
    const event = JSON.parse(await readArtifact(config, artifact))
    Decision.parse(event.input)
    if (!Number.isSafeInteger(event.revision) || event.revision < 1) throw new Error('INVALID_EVENT_REVISION')
    events.push({ ...event, artifact })
  }
  return events.sort((a, b) => a.revision - b.revision || a.artifact.localeCompare(b.artifact))
}

export function latestApplications(events) {
  const latest = new Map()
  for (const event of events) {
    const previous = latest.get(event.input.patternKey)
    if (event.revision !== (previous?.revision ?? 0) + 1) throw new Error('BROKEN_APPLICATION_HISTORY')
    latest.set(event.input.patternKey, event)
  }
  return latest
}

export async function recordApplication(config, value) {
  const input = Decision.parse(value)
  if (sanitize(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('UNSANITIZED_APPLICATION_INPUT')
  input.patternKey = canonicalKey(config, input.patternKey)
  const base = join(config.store, 'applications')
  await mkdir(base, { recursive: true, mode: 0o700 })
  const lock = join(base, '.writer-lock')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('APPLICATION_WRITER_BUSY')
    throw error
  }
  try {
    const entries = (await applicationEntries(config)).filter(
      (entry) => canonicalKey(config, entry.patternKey) === input.patternKey,
    )
    if (!entries.length || input.entryIds.some((id) => !entries.some((entry) => entry.id === id)))
      throw new Error('UNKNOWN_APPLICATION_SOURCE')
    const previous = latestApplications(await applicationEvents(config)).get(input.patternKey)
    if (input.expectedRevision !== (previous?.revision ?? 0)) throw new Error('APPLICATION_REVISION_CONFLICT')
    const evidence = []
    const references = new Set([
      ...input.evidence,
      ...input.checks.map((item) => item.evidence),
      ...input.runtime.evidence,
    ])
    for (const artifact of references) evidence.push({ artifact, sha256: sha256(await readArtifact(config, artifact)) })
    const targets = []
    for (const item of input.targets) {
      const snapshot = z
        .object({ version: z.literal(1), path: z.string(), text: z.string(), sha256: z.string() })
        .parse(JSON.parse(await readArtifact(config, item.snapshot)))
      if (sha256(snapshot.text) !== snapshot.sha256) throw new Error('CORRUPT_TARGET_SNAPSHOT')
      const target = await targetPath(config, snapshot.path)
      const text = await readBounded(target.path)
      if (sha256(text) !== item.afterHash) throw new Error('TARGET_HASH_MISMATCH')
      if ((snapshot.sha256 === item.afterHash) !== (item.change === 'existing')) throw new Error('CHANGE_KIND_MISMATCH')
      if (target.policy) assertProtectedPolicy(target.policy, snapshot.text, text)
      if (item.anchor && !target.policy) throw new Error('ANCHOR_POLICY_ONLY')
      targets.push({
        path: target.path,
        beforeHash: snapshot.sha256,
        afterHash: item.afterHash,
        snapshot: item.snapshot,
        ...(item.anchor ? { anchor: item.anchor, anchorBlock: policyRuleBlock(text, item.anchor) } : {}),
      })
    }
    if (new Set(targets.map((target) => target.path)).size !== targets.length) throw new Error('DUPLICATE_TARGET')
    const receipts = []
    for (const check of input.checks) {
      if (!check.evidence.startsWith('applications/checks/')) throw new Error('CAPTURED_CHECK_REQUIRED')
      const receipt = VerificationReceipt.parse(JSON.parse(await readArtifact(config, check.evidence)))
      if (
        receipt.exitCode !== 0 ||
        receipt.timedOut ||
        receipt.outputTruncated ||
        receipt.kind !== check.kind ||
        receipt.command !== check.command ||
        receipt.cwd !== check.cwd ||
        receipt.scope !== check.scope
      )
        throw new Error('CHECK_RECEIPT_MISMATCH')
      if (
        !receipt.targets.some((checked) =>
          targets.some((target) => target.path === checked.path && target.afterHash === checked.sha256),
        )
      )
        throw new Error('CHECK_NOT_BOUND_TO_TARGET')
      if (check.kind === 'runtime' && receipt.origin !== 'runtime-probe') {
        if (!receipt.approvalEvidence) throw new Error('RUNTIME_APPROVAL_REQUIRED')
        evidence.push({
          artifact: receipt.approvalEvidence,
          sha256: sha256(await readArtifact(config, receipt.approvalEvidence)),
        })
      }
      receipts.push(receipt)
    }
    if (input.decision === 'applied') {
      for (const target of targets) {
        const policy = config.policies.find((item) => item.path === target.path)
        const bound = receipts.filter((receipt) =>
          receipt.targets.some((item) => item.path === target.path && item.sha256 === target.afterHash),
        )
        if (!bound.length) throw new Error('UNCHECKED_TARGET')
        if (!policy && !bound.some((check) => ['test', 'typecheck', 'lint', 'build'].includes(check.kind)))
          throw new Error('CODE_APPLICATION_REQUIRES_EXECUTED_CHECK')
      }
    }
    const event = {
      version: 1,
      recordedAt: new Date().toISOString(),
      revision: input.expectedRevision + 1,
      sourceDigest: sourceDigest(entries),
      input,
      targets,
      evidence,
    }
    const artifact = await saveArtifact(config, 'events', event)
    return { artifact, revision: event.revision, decision: input.decision, runtime: input.runtime.status }
  } finally {
    await rmdir(lock)
  }
}

async function targetChanged(target) {
  const text = await readBounded(target.path)
  if (!target.anchor) return sha256(text) !== target.afterHash
  if (!target.anchorBlock) return true
  try {
    const block = policyRuleBlock(text, target.anchor)
    return block.heading !== target.anchorBlock.heading || block.sha256 !== target.anchorBlock.sha256
  } catch (error) {
    if (['ANCHOR_NOT_FOUND', 'ANCHOR_NOT_UNIQUE'].includes(error.message)) return true
    throw error
  }
}

export async function applicationInventory(config) {
  const entries = await applicationEntries(config)
  const latest = latestApplications(await applicationEvents(config))
  const grouped = new Map()
  for (const entry of entries.filter((entry) => entry.status !== 'superseded')) {
    const key = canonicalKey(config, entry.patternKey)
    grouped.set(key, [...(grouped.get(key) ?? []), entry])
  }
  const items = []
  for (const [patternKey, sources] of grouped) {
    const event = latest.get(patternKey)
    const allSources = entries.filter((entry) => canonicalKey(config, entry.patternKey) === patternKey)
    const sourceChanged = !!event && event.sourceDigest !== sourceDigest(allSources)
    let evidenceChanged = false
    for (const evidence of event?.evidence ?? []) {
      try {
        if (sha256(await readArtifact(config, evidence.artifact)) !== evidence.sha256) evidenceChanged = true
      } catch (error) {
        if (error.code === 'ENOENT') evidenceChanged = true
        else throw error
      }
    }
    let drifted = false
    if (event?.input.decision === 'applied') {
      for (const target of event.targets) {
        try {
          if (await targetChanged(target)) drifted = true
        } catch (error) {
          if (error.code === 'ENOENT') drifted = true
          else throw error
        }
      }
    }
    const state = !event
      ? 'unassessed'
      : drifted
        ? 'drifted'
        : sourceChanged
          ? 'source_changed'
          : evidenceChanged
            ? 'evidence_changed'
            : event.input.decision
    items.push({
      patternKey,
      entryIds: sources.map((entry) => entry.id),
      entryFiles: sources.map((entry) => entry.source.path),
      learningStatuses: [...new Set(sources.map((entry) => entry.status))],
      state,
      revision: event?.revision ?? 0,
      runtime: state === 'applied' ? event.input.runtime.status : 'unconfirmed',
      unblockWhen: event?.input.unblockWhen ?? null,
      firstObservedAt: sources.map((entry) => entry.observedAt).sort()[0],
    })
  }
  items.sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.patternKey.localeCompare(b.patternKey))
  const counts = {}
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1
  return { entries: entries.length, patterns: items.length, counts, items }
}
