import { readBounded, sha256 } from './application-files.mjs'
import { sanitize } from './search-entries.mjs'

export function policySections(policy, text) {
  const lines = text.split('\n')
  const sections = []
  const occurrences = new Map()
  let heading = '(preamble)'
  let start = 0
  let fence = null
  const append = (end) => {
    if (end === start) return
    const occurrence = occurrences.get(heading) ?? 0
    occurrences.set(heading, occurrence + 1)
    const body = lines.slice(start, end).join('\n').trimEnd()
    sections.push({
      id: `${policy.id}:${sha256(heading).slice(0, 16)}:${occurrence}`,
      heading,
      line: start + 1,
      sha256: sha256(body),
      protected: heading === '(preamble)' || policy.protectedHeadings.includes(heading),
      text: body,
    })
  }
  for (let index = 0; index < lines.length; index++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index])
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    const match = !fence && /^#{1,6}\s+(.+?)\s*$/.exec(lines[index])
    if (!match) continue
    append(index)
    heading = match[1]
    start = index
  }
  append(lines.length)
  return sections
}

export function policyRuleBlock(text, anchor) {
  const matches = []
  let heading = '(preamble)'
  let fence = null
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) heading = match[1]
    if (line.includes(anchor)) matches.push({ heading, sha256: sha256(line.trim()) })
  }
  if (!matches.length) throw new Error('ANCHOR_NOT_FOUND')
  if (matches.length > 1) throw new Error('ANCHOR_NOT_UNIQUE')
  return matches[0]
}

export async function policyInventory(config) {
  const policies = []
  let bytes = 0
  for (const policy of config.policies) {
    const text = await readBounded(policy.path)
    bytes += Buffer.byteLength(text)
    if (bytes > 1024 * 1024) throw new Error('POLICY_INVENTORY_TOO_LARGE')
    policies.push({ ...policy, sha256: sha256(text), text, sections: policySections(policy, text) })
  }
  return policies
}

export function assertProtectedPolicy(policy, before, after) {
  if (!policy.mutable && before !== after) throw new Error('READONLY_POLICY_CHANGED')
  const next = new Map(policySections(policy, after).map((section) => [section.id, section.text]))
  for (const section of policySections(policy, before)) {
    if (section.protected && !samePolicyContent(next.get(section.id), section.text))
      throw new Error('PROTECTED_POLICY_CHANGED')
  }
}

export function samePolicyContent(before, after) {
  if (before === undefined || after === undefined) return false
  const normalize = (text) =>
    text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .join('\n')
  return normalize(before) === normalize(after)
}

export async function policyAnalysisRecords(config) {
  const policies = await policyInventory(config)
  return policies.flatMap((policy) =>
    policy.sections.map((section) => ({
      id: `policy/${section.id}`,
      kind: 'current-instruction',
      path: policy.path,
      sha256: policy.sha256,
      sectionHash: section.sha256,
      protected: section.protected || !policy.mutable,
      text: sanitize(section.text),
    })),
  )
}
