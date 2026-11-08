const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/

export function parseStable(value) {
  const match = STABLE.exec(String(value ?? '').trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function normalize(value) {
  const parts = parseStable(value)
  return parts ? parts.join('.') : null
}

export function compareVersions(left, right) {
  const [a, b] = [parseStable(left), parseStable(right)]
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function bumpKind(from, to) {
  const [a, b] = [parseStable(from), parseStable(to)]
  if (!a || !b || compareVersions(to, from) <= 0) return 'none'
  if (a[0] !== b[0]) return 'major'
  return a[1] !== b[1] ? 'minor' : 'patch'
}

export function newerVersions(versions, baseline) {
  const unique = [...new Set(versions.map(normalize).filter(Boolean))]
  return unique.filter((version) => compareVersions(version, baseline) > 0).sort(compareVersions)
}

function sameLine(left, right) {
  const [a, b] = [parseStable(left), parseStable(right)]
  return a[0] === b[0] && a[1] === b[1]
}

export function previousInLine(version, allVersions) {
  const earlier = allVersions.filter((other) => sameLine(other, version) && compareVersions(other, version) < 0)
  return earlier.sort(compareVersions).at(-1) ?? null
}

export function selectNoteVersions(candidates, allVersions, recent) {
  const byMajor = Map.groupBy(candidates, (version) => parseStable(version)[0])
  const selected = [...byMajor.values()].flatMap((group) => {
    const sorted = [...group].sort(compareVersions)
    const starts = sorted.filter((version) => !previousInLine(version, allVersions))
    return [...starts, ...sorted.slice(-recent)]
  })
  return [...new Set(selected)].sort(compareVersions)
}

export function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(이하 생략, 원문 링크 참조)`
}
