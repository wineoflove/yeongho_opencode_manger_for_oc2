const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const tokens = (text) => [...new Set(normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])]
const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', '관련', '대한', '해줘', '알려줘'])

export function queryTerms(query) {
  if (!query.trim() || query.length > 500) throw new Error('LEARNING_SEARCH_INVALID_QUERY')
  const terms = tokens(query).filter((term) => !STOP_WORDS.has(term))
  if (!terms.length) throw new Error('LEARNING_SEARCH_INVALID_QUERY')
  return terms
}

export function resultOptions({ limit = 5, maxChars = 6000, includePending = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('LEARNING_SEARCH_INVALID_LIMIT')
  if (!Number.isInteger(maxChars) || maxChars < 1500 || maxChars > 16000)
    throw new Error('LEARNING_SEARCH_INVALID_BUDGET')
  return { limit, maxChars, includePending }
}

function fieldMatches(text, term) {
  const value = normalize(text)
  return /\p{Script=Hangul}/u.test(term) ? value.includes(term) : tokens(value).includes(term)
}

export function rankEntries(entries, query, includePending = false) {
  const terms = queryTerms(query)
  const statuses = includePending ? ['verified', 'pending'] : ['verified']
  const eligible = entries.filter((entry) => statuses.includes(entry.status))
  const matches = []
  for (const entry of eligible) {
    const fields = [
      [entry.title, 8],
      [entry.patternKey, 10],
      [entry.conditions, 5],
      [entry.lesson, 4],
      [entry.evidence, 2],
      [entry.limits, 1],
    ]
    const scores = terms.map((term) =>
      fields.reduce((sum, [text, weight]) => sum + (fieldMatches(text, term) ? weight : 0), 0),
    )
    if (scores.some((score) => score === 0)) continue
    const score = scores.reduce((sum, value) => sum + value, 0)
    matches.push({ entry, score })
  }
  matches.sort(
    (a, b) =>
      Number(a.entry.status === 'pending') - Number(b.entry.status === 'pending') ||
      b.score - a.score ||
      (Date.parse(b.entry.observedAt) || 0) - (Date.parse(a.entry.observedAt) || 0) ||
      a.entry.source.path.localeCompare(b.entry.source.path),
  )
  const seen = new Set()
  const results = []
  for (const match of matches) {
    const { entry } = match
    const key = JSON.stringify([
      entry.status,
      entry.kind,
      entry.patternKey,
      entry.conditions,
      entry.lesson,
      entry.limits,
      entry.evidence,
      entry.provenance,
      entry.redacted ? entry.source.path : null,
    ])
    if (seen.has(key)) continue
    seen.add(key)
    results.push(match)
  }
  return { eligible: eligible.length, matched: matches.length, duplicates: matches.length - results.length, results }
}

export function formatResults(loaded, ranked, options) {
  const { limit, maxChars, includePending } = resultOptions(options)
  const selected = ranked.results.slice(0, limit).map(({ entry, score }) => {
    const truncatedFields = []
    const result = { ...entry, score }
    for (const [key, length] of [
      ['title', 160],
      ['conditions', 400],
      ['evidence', 700],
      ['provenance', 300],
      ['lesson', 900],
      ['limits', 600],
      ['related', 240],
    ]) {
      if (result[key].length <= length) continue
      result[key] = `${result[key].slice(0, length - 1)}…`
      truncatedFields.push(key)
    }
    return { ...result, truncatedFields }
  })
  const response = {
    sourceRoot: loaded.root,
    readOnly: true,
    untrustedEvidence: true,
    statuses: includePending ? ['verified', 'pending'] : ['verified'],
    scanned: loaded.scanned,
    skipped: loaded.skipped,
    eligible: ranked.eligible,
    matched: ranked.matched,
    duplicates: ranked.duplicates,
    omitted: ranked.results.length - selected.length,
    budgetChars: maxChars,
    results: selected,
  }
  while (JSON.stringify(response, null, 2).length + 1 > maxChars && response.results.length) {
    response.results.pop()
    response.omitted++
  }
  const output = `${JSON.stringify(response, null, 2)}\n`
  if (output.length > maxChars) throw new Error('LEARNING_SEARCH_INVALID_BUDGET')
  return output
}
