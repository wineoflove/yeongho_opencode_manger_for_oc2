import { afterEach, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, record } from './search-fixtures.mjs'

const cli = fileURLToPath(new URL('./lint.mjs', import.meta.url))
const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function store(records) {
  const root = await createStore(records)
  roots.push(root)
  return root
}
function run(entries) {
  return spawnSync(process.execPath, ['--no-env-file', cli, '--entries', entries], { encoding: 'utf8' })
}
async function snapshot(entries) {
  return Promise.all(
    (await readdir(entries)).sort().map(async (file) => ({
      file,
      text: await readFile(join(entries, file), 'utf8'),
      mtime: (await stat(join(entries, file))).mtimeMs,
    })),
  )
}

it('lints reordered metadata read-only and counts every status', async () => {
  const entries = await store(
    Object.fromEntries(
      ['verified', 'pending', 'superseded'].map((status) => {
        const lines = record({ id: status, status }).split('\n')
        return [`${status}.md`, [lines[0], ...lines.slice(1, 10).reverse(), ...lines.slice(10)].join('\n')]
      }),
    ),
  )
  const before = await snapshot(entries)
  const result = run(entries)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    scanned: 3,
    counts: { verified: 1, pending: 1, superseded: 1, other: 0 },
    violations: [],
  })
  expect(await snapshot(entries)).toEqual(before)
})

it('reports mismatches, duplicate IDs, invalid enums, patterns and unresolved related sorted by file/code', async () => {
  const entries = await store({
    'a.md': record({ id: 'duplicate' }).replace('Related: none', 'Related: b,missing'),
    'b.md': record({ id: 'duplicate' }),
    'c.md': record({ id: 'c', status: 'unknown', pattern: 'BAD' })
      .replace('Kind: preference', 'Kind: unknown')
      .replace('Related: none', 'Related: duplicate'),
  })
  const before = await snapshot(entries)
  const result = run(entries)
  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output.counts).toEqual({ verified: 2, pending: 0, superseded: 0, other: 1 })
  expect(output.violations.map(({ file, code }) => [file, code])).toEqual([
    ['a.md', 'DUPLICATE_ID'],
    ['a.md', 'ID_FILENAME_MISMATCH'],
    ['a.md', 'UNKNOWN_RELATED'],
    ['b.md', 'DUPLICATE_ID'],
    ['b.md', 'ID_FILENAME_MISMATCH'],
    ['c.md', 'INVALID_KIND'],
    ['c.md', 'INVALID_PATTERN_KEY'],
    ['c.md', 'INVALID_STATUS'],
  ])
  expect(output.violations.every((item) => typeof item.id === 'string' && typeof item.detail === 'string')).toBe(true)
  expect(await snapshot(entries)).toEqual(before)
})

it('reports every missing or empty required field, including body headings', async () => {
  for (const field of [
    'title',
    'ID',
    'Pattern-Key',
    'Status',
    'Kind',
    'Observed-At',
    'Source',
    'Conditions',
    'Evidence',
    'Related',
    '## Lesson',
    '## Limits',
  ]) {
    const text = record({ id: 'entry' })
    const pattern =
      field === 'title'
        ? /^# .+$/m
        : field.startsWith('##')
          ? new RegExp(`^${field}$`, 'm')
          : new RegExp(`^${field}:.*$`, 'm')
    const entries = await store({ 'entry.md': text.replace(pattern, '') })
    const output = JSON.parse(run(entries).stdout)
    expect(output.violations).toContainEqual({
      file: 'entry.md',
      id: field === 'ID' ? '' : 'entry',
      code: 'MISSING_FIELD',
      detail: field,
    })
  }
  const entries = await store({ 'entry.md': record({ id: 'entry' }).replace('Source: 사용자 교정', 'Source:   ') })
  expect(JSON.parse(run(entries).stdout).violations).toContainEqual({
    file: 'entry.md',
    id: 'entry',
    code: 'MISSING_FIELD',
    detail: 'Source',
  })
})

it('returns exit 2 for an unreadable directory', () => {
  const result = run('/missing-task-7-lint-store')
  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
})
