import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { KINDS, METADATA_FIELDS, PATTERN_KEY, readEntryDocuments, relatedNames } from './entry-schema.mjs'

export async function lintEntries(directory) {
  const documents = await readEntryDocuments(directory)
  const names = relatedNames(documents)
  const ids = new Map()
  for (const { fields } of documents) if (fields.ID) ids.set(fields.ID, (ids.get(fields.ID) ?? 0) + 1)
  const counts = { verified: 0, pending: 0, superseded: 0, other: 0 }
  const violations = []
  for (const { file, name, text, fields } of documents) {
    const add = (code, detail) => violations.push({ file, id: fields.ID, code, detail })
    if (!/^#[ \t]+\S.*$/m.test(text)) add('MISSING_FIELD', 'title')
    for (const key of METADATA_FIELDS) if (!fields[key]) add('MISSING_FIELD', key)
    for (const heading of ['## Lesson', '## Limits'])
      if (!text.split('\n').some((line) => line.trimEnd() === heading)) add('MISSING_FIELD', heading)
    const validStatus = ['verified', 'pending', 'superseded'].includes(fields.Status)
    counts[validStatus ? fields.Status : 'other']++
    if (fields.ID && fields.ID !== name) add('ID_FILENAME_MISMATCH', name)
    if (ids.get(fields.ID) > 1) add('DUPLICATE_ID', fields.ID)
    if (fields.Status && !validStatus) add('INVALID_STATUS', 'Status')
    if (fields.Kind && !KINDS.has(fields.Kind)) add('INVALID_KIND', 'Kind')
    if (fields['Pattern-Key'] && !PATTERN_KEY.test(fields['Pattern-Key'])) add('INVALID_PATTERN_KEY', 'Pattern-Key')
    for (const reference of fields.Related.split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (reference !== 'none' && !names.has(reference)) add('UNKNOWN_RELATED', reference)
    }
  }
  violations.sort(
    (first, second) =>
      first.file.localeCompare(second.file) ||
      first.code.localeCompare(second.code) ||
      first.detail.localeCompare(second.detail),
  )
  return { scanned: documents.length, counts, violations }
}

async function main() {
  const { values } = parseArgs({ options: { entries: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    process.stdout.write('Usage: bun --no-env-file lint.mjs --entries <dir>\n')
    return
  }
  if (!values.entries) throw new Error('Missing entries')
  process.stdout.write(`${JSON.stringify(await lintEntries(values.entries), null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ error: 'LEARNING_LINT_FAILED' })}\n`)
    process.exitCode = 2
  })
}
