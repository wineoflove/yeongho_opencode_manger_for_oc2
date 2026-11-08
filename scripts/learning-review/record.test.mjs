import { afterEach, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, record } from './search-fixtures.mjs'

const cli = fileURLToPath(new URL('./record.mjs', import.meta.url))
const roots = []
const now = '2026-10-14T12:34:56.000Z'
const valid = {
  title: 'Scoped memory',
  patternKey: 'memory.safe-record',
  status: 'verified',
  kind: 'solution',
  source: 'offline test',
  conditions: 'Temporary entries only',
  evidence: 'The offline CLI test passed and left existing files unchanged.',
  related: [],
  lesson: 'Create exclusively.',
  limits: 'No live writes.',
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function store(records = {}) {
  const root = await createStore(records)
  roots.push(root)
  return root
}
function run(entries, input, args = []) {
  return spawnSync(process.execPath, ['--no-env-file', cli, '--entries', entries, '--now', now, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  })
}

it('creates a UTC ID exclusively, normalizes metadata and resolves ID or filename references', async () => {
  const entries = await store({ 'old-name.md': record({ id: 'old-id' }) })
  const result = run(entries, {
    ...valid,
    title: 'Scoped\nmemory',
    source: 'offline\r\ntest',
    related: ['old-id', 'old-name'],
  })
  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output.id).toMatch(/^20261014T123456Z-[a-f0-9]{4}-safe-record$/)
  expect(output).toEqual({ id: output.id, path: join(await realpath(entries), `${output.id}.md`), status: 'verified' })
  expect(await readFile(output.path, 'utf8')).toBe(
    `# Scoped memory\nID: ${output.id}\nPattern-Key: memory.safe-record\nStatus: verified\nKind: solution\nObserved-At: ${now}\nSource: offline test\nConditions: Temporary entries only\nEvidence: ${valid.evidence}\nRelated: old-id,old-name\n\n## Lesson\nCreate exclusively.\n\n## Limits\nNo live writes.\n`,
  )
  expect(await readFile(join(entries, 'old-name.md'), 'utf8')).toBe(record({ id: 'old-id' }))
})

it('rejects malformed JSON, missing and empty fields, and length overflows without writes', async () => {
  const entries = await store()
  for (const input of ['{', 'null', '[]']) {
    const result = run(entries, input)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({ error: 'LEARNING_RECORD_INVALID_FIELD', field: 'input' })
  }
  for (const [field, maximum] of Object.entries({
    title: 160,
    source: 400,
    conditions: 800,
    evidence: 1500,
    lesson: 1500,
    limits: 1200,
  })) {
    for (const value of [undefined, '', ' \n ', 'x'.repeat(maximum + 1), 42]) {
      const result = run(entries, { ...valid, [field]: value })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stderr)).toEqual({ error: 'LEARNING_RECORD_INVALID_FIELD', field })
    }
    expect(run(entries, { ...valid, status: 'pending', [field]: 'x'.repeat(maximum) }).status).toBe(0)
  }
  expect((await readdir(entries)).length).toBe(6)
})

it('validates enums, keys, evidence and related with exact codes and no new files', async () => {
  const entries = await store()
  const cases = [
    ['status', 'superseded', 'INVALID_STATUS'],
    ['status', '', 'INVALID_STATUS'],
    ['status', undefined, 'INVALID_STATUS'],
    ['kind', 'fact', 'INVALID_KIND'],
    ['kind', undefined, 'INVALID_KIND'],
    ...['plain', 'Upper.key', 'area.bad_key', 'area..key', 'area.-key', 'area.key-', 'area.key\n', '', undefined].map(
      (value) => ['patternKey', value, 'INVALID_PATTERN_KEY'],
    ),
    ['evidence', 'x'.repeat(39), 'VERIFIED_NEEDS_EVIDENCE'],
    ['related', ['missing'], 'UNKNOWN_RELATED'],
    ['related', Array(11).fill('missing'), 'INVALID_FIELD'],
    ['related', 'none', 'INVALID_FIELD'],
    ['related', undefined, 'INVALID_FIELD'],
    ['related', [4], 'INVALID_FIELD'],
  ]
  for (const [field, value, code] of cases) {
    const result = run(entries, { ...valid, [field]: value })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ error: `LEARNING_RECORD_${code}`, field })
  }
  expect(await readdir(entries)).toEqual([])
  expect(run(entries, { ...valid, evidence: 'x'.repeat(40) }).status).toBe(0)
  expect(
    run(entries, { ...valid, status: 'pending', evidence: 'x', patternKey: `memory.${'x'.repeat(50)}` }).status,
  ).toBe(0)
  expect((await readdir(entries)).some((name) => name.endsWith(`-${'x'.repeat(40)}.md`))).toBe(true)
})

it('rejects all specified secret families without leaking them or writing files', async () => {
  const entries = await store()
  const secrets = [
    '-----BEGIN RSA PRIVATE KEY-----',
    `sk-${'a'.repeat(20)}`,
    `ghp_${'a'.repeat(20)}`,
    `xoxb-${'a'.repeat(10)}`,
    `BeArEr ${'a'.repeat(20)}`,
    'API_KEY: abcdefgh',
    'password=abcdefgh',
    'secret: abcdefgh',
    'token=abcdefgh',
  ]
  for (const secret of secrets) {
    const result = run(entries, { ...valid, lesson: secret })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({ error: 'LEARNING_RECORD_SECRET_DETECTED', field: 'lesson' })
    expect(result.stderr).not.toContain(secret)
  }
  expect(await readdir(entries)).toEqual([])
})

it('retries exactly three collisions and preserves existing bytes', async () => {
  const { recordLearning } = await import('./record.mjs')
  const entries = await store()
  const filename = '20261014T123456Z-abcd-safe-record.md'
  await writeFile(join(entries, filename), 'unchanged')
  let attempts = 0
  await expect(
    recordLearning(
      valid,
      { entries, now },
      {
        randomSuffix: () => {
          attempts++
          return 'abcd'
        },
      },
    ),
  ).rejects.toMatchObject({ message: 'LEARNING_RECORD_EXISTS', field: 'id' })
  expect(attempts).toBe(3)
  expect(await readFile(join(entries, filename), 'utf8')).toBe('unchanged')
  let retries = 0
  const result = await recordLearning(
    valid,
    { entries, now },
    { randomSuffix: () => (++retries === 1 ? 'abcd' : 'dcba') },
  )
  expect(result.id).toContain('-dcba-')
})

it('removes only its new file when the loadEntries self-check cannot see the ID', async () => {
  const { recordLearning } = await import('./record.mjs')
  const entries = await store({ 'keep.md': record() })
  await expect(
    recordLearning(valid, { entries, now }, { readEntries: async () => ({ entries: [] }) }),
  ).rejects.toMatchObject({ message: 'LEARNING_RECORD_SELF_CHECK_FAILED' })
  expect(await readdir(entries)).toEqual(['keep.md'])
  expect(run(entries, { ...valid, lesson: '## Lesson\nduplicate section' }).status).toBe(1)
  expect(await readdir(entries)).toEqual(['keep.md'])
})

it('requires an explicit entries directory and a valid ISO time', async () => {
  const entries = await store()
  const missing = spawnSync(process.execPath, ['--no-env-file', cli], {
    input: JSON.stringify(valid),
    encoding: 'utf8',
  })
  expect(missing.status).toBe(1)
  expect(JSON.parse(missing.stderr).field).toBe('entries')
  expect(run(entries, valid, ['--now', 'invalid']).status).toBe(1)
  expect(await readdir(entries)).toEqual([])
})

it('supports a symlinked entries directory while self-checking the actual created file', async () => {
  const entries = await store()
  const parent = await store()
  const alias = join(parent, 'alias')
  await symlink(entries, alias)
  const result = run(alias, valid)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).path).toStartWith(`${await realpath(entries)}/`)
  expect((await readdir(entries)).length).toBe(1)
})
