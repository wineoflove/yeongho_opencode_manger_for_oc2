import { afterEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, record } from './search-fixtures.mjs'

const cli = fileURLToPath(new URL('./search.mjs', import.meta.url))
const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fingerprints(directory) {
  const records = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const info = await stat(path)
    records.push({
      name,
      mtime: info.mtimeMs,
      hash: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })
  }
  return records
}

it('works from another cwd with a bounded JSON response and no source writes', async () => {
  const entries = await createStore({
    'verified.md': record(),
    'pending.md': record({ id: 'candidate', status: 'pending' }),
  })
  const otherCwd = await createStore({})
  roots.push(entries, otherCwd)
  const before = await fingerprints(entries)
  const output = execFileSync(process.execPath, ['--no-env-file', cli, '한국어 응답', '--entries', entries], {
    cwd: otherCwd,
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  expect(result.results.map((hit) => hit.id)).toEqual(['observation'])
  expect(result.readOnly).toBe(true)
  expect(await fingerprints(entries)).toEqual(before)
  expect(await readdir(otherCwd)).toEqual([])
})

it('supports explicit pending review without changing candidate status', async () => {
  const entries = await createStore({ 'pending.md': record({ id: 'candidate', status: 'pending' }) })
  roots.push(entries)
  const output = execFileSync(
    process.execPath,
    ['--no-env-file', cli, '한국어', '--entries', entries, '--include-pending'],
    { encoding: 'utf8' },
  )
  const result = JSON.parse(output)
  expect(result.results[0].status).toBe('pending')
  expect(await readFile(join(entries, 'pending.md'), 'utf8')).toContain('Status: pending')
})

it('fails safely for missing input paths and malformed arguments without echoing sensitive input', () => {
  for (const args of [['한국어', '--entries', '/missing-learning-fixture'], ['--limit', '-1', '한국어'], []]) {
    const result = spawnSync(process.execPath, ['--no-env-file', cli, ...args], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toStartWith('LEARNING_SEARCH_')
    expect(result.stderr).not.toContain('/missing-learning-fixture')
  }
})

it('batch preserves ranking, limits, pending opt-in and individual invalid queries without writes', async () => {
  const entries = await createStore({
    'verified.md': record(),
    'pending.md': record({ id: 'candidate', status: 'pending', lesson: '후보 전용' }),
  })
  roots.push(entries)
  const before = await fingerprints(entries)
  const input = JSON.stringify(['한국어', '', '!!!', 'the and', '없는검색어', '후보'])
  const result = spawnSync(process.execPath, ['--no-env-file', cli, '--batch', '--entries', entries, '--limit', '1'], {
    input,
    encoding: 'utf8',
  })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    { query: '한국어', ids: ['observation'] },
    ...['', '!!!', 'the and'].map((query) => ({ query, ids: [], error: 'LEARNING_SEARCH_INVALID_QUERY' })),
    { query: '없는검색어', ids: [] },
    { query: '후보', ids: [] },
  ])
  const pending = spawnSync(
    process.execPath,
    ['--no-env-file', cli, '--batch', '--entries', entries, '--include-pending'],
    { input: '["후보"]', encoding: 'utf8' },
  )
  expect(JSON.parse(pending.stdout)).toEqual([{ query: '후보', ids: ['candidate'] }])
  expect(await fingerprints(entries)).toEqual(before)
})

it('batch rejects malformed JSON, wrong shapes and over-budget batches', async () => {
  const entries = await createStore({})
  roots.push(entries)
  for (const input of [
    '{',
    '{}',
    'null',
    '[1]',
    '[null]',
    JSON.stringify(['x'.repeat(501)]),
    JSON.stringify(Array(51).fill('query')),
  ]) {
    const result = spawnSync(process.execPath, ['--no-env-file', cli, '--batch', '--entries', entries], {
      input,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ error: 'LEARNING_SEARCH_INVALID_BATCH' })
  }
  for (const queries of [[], Array(50).fill('x'.repeat(500))]) {
    const result = spawnSync(process.execPath, ['--no-env-file', cli, '--batch', '--entries', entries], {
      input: JSON.stringify(queries),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).length).toBe(queries.length)
  }
})
