import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { KINDS, PATTERN_KEY, readEntryDocuments, relatedNames } from './entry-schema.mjs'
import { loadEntries } from './search-entries.mjs'

const LENGTHS = { title: 160, source: 400, conditions: 800, evidence: 1500, lesson: 1500, limits: 1200 }
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /bearer\s+[A-Za-z0-9._-]{20,}/i,
  /(api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i,
]

function fail(code, field) {
  throw Object.assign(new Error(`LEARNING_RECORD_${code}`), { field })
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_FIELD', 'input')
  for (const [field, maximum] of Object.entries(LENGTHS)) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > maximum)
      fail('INVALID_FIELD', field)
  }
  if (
    typeof input.patternKey !== 'string' ||
    input.patternKey.trim() !== input.patternKey ||
    !PATTERN_KEY.test(input.patternKey)
  )
    fail('INVALID_PATTERN_KEY', 'patternKey')
  if (!['pending', 'verified'].includes(input.status)) fail('INVALID_STATUS', 'status')
  if (!KINDS.has(input.kind)) fail('INVALID_KIND', 'kind')
  if (input.status === 'verified' && input.evidence.trim().length < 40) fail('VERIFIED_NEEDS_EVIDENCE', 'evidence')
  if (
    !Array.isArray(input.related) ||
    input.related.length > 10 ||
    input.related.some((value) => typeof value !== 'string' || !value.trim())
  )
    fail('INVALID_FIELD', 'related')
  for (const field of [...Object.keys(LENGTHS), 'patternKey', 'status', 'kind', 'related']) {
    const text = field === 'related' ? input.related.join('\n') : input[field]
    if (SECRETS.some((pattern) => pattern.test(text))) fail('SECRET_DETECTED', field)
  }
}

function render(input, id, observedAt) {
  const oneLine = (value) => value.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').trim()
  return `# ${oneLine(input.title)}\nID: ${id}\nPattern-Key: ${input.patternKey}\nStatus: ${input.status}\nKind: ${input.kind}\nObserved-At: ${observedAt}\nSource: ${oneLine(input.source)}\nConditions: ${oneLine(input.conditions)}\nEvidence: ${oneLine(input.evidence)}\nRelated: ${input.related.length ? input.related.map(oneLine).join(',') : 'none'}\n\n## Lesson\n${input.lesson.trim()}\n\n## Limits\n${input.limits.trim()}\n`
}

export async function recordLearning(
  input,
  { entries, now = new Date().toISOString() },
  { randomSuffix = () => randomBytes(2).toString('hex'), readEntries = loadEntries } = {},
) {
  if (typeof entries !== 'string' || !entries.trim()) fail('INVALID_FIELD', 'entries')
  validate(input)
  if (
    typeof now !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(now) ||
    !Number.isFinite(Date.parse(now))
  )
    fail('INVALID_FIELD', 'now')
  const observedAt = new Date(now).toISOString()
  const root = realpathSync(entries)
  const known = relatedNames(await readEntryDocuments(root))
  if (input.related.some((reference) => !known.has(reference))) fail('UNKNOWN_RELATED', 'related')
  const timestamp = observedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const slug = input.patternKey
    .split('.')
    .at(-1)
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40)
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `${timestamp}-${randomSuffix()}-${slug}`
    const path = join(root, `${id}.md`)
    let descriptor
    try {
      descriptor = openSync(path, 'wx', 0o644)
    } catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
    try {
      try {
        writeFileSync(descriptor, render(input, id, observedAt))
      } finally {
        closeSync(descriptor)
      }
      const loaded = await readEntries(root)
      if (!loaded.entries.some((entry) => entry.id === id && entry.source.path === path))
        fail('SELF_CHECK_FAILED', 'id')
      return { id, path, status: input.status }
    } catch (error) {
      unlinkSync(path)
      if (error.message === 'LEARNING_RECORD_SELF_CHECK_FAILED') throw error
      fail('SELF_CHECK_FAILED', 'id')
    }
  }
  fail('EXISTS', 'id')
}

async function main() {
  const { values } = parseArgs({
    options: { entries: { type: 'string' }, now: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    process.stdout.write('Usage: bun --no-env-file record.mjs --entries <dir> [--now <ISO>] < record.json\n')
    return
  }
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    fail('INVALID_FIELD', 'input')
  }
  process.stdout.write(`${JSON.stringify(await recordLearning(input, values))}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const known = /^LEARNING_RECORD_[A-Z_]+$/.test(error.message)
    process.stderr.write(
      `${JSON.stringify({ error: known ? error.message : 'LEARNING_RECORD_INVALID_FIELD', field: known ? error.field : 'entries' })}\n`,
    )
    process.exitCode = 1
  })
}
