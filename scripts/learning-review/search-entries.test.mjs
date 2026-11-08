import { afterEach, expect, it } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEntries, parseEntry } from './search-entries.mjs'
import { createStore, record } from './search-fixtures.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([
  ['교정', '한계'],
  ['교훈', '검증 범위'],
])('parses Korean headings %s/%s and preserves source line references', (lesson, limits) => {
  const text = record().replace('## Lesson', `## ${lesson}`).replace('## Limits', `## ${limits}`)
  const entry = parseEntry(text, '/global/entries/example.md')
  expect(entry.status).toBe('verified')
  expect(entry.lesson).toBe('영어 자료를 읽어도 한국어로 응답한다.')
  expect(entry.limits).toBe('코드와 명령은 원문을 보존한다.')
  expect(text.split('\n')[entry.source.evidenceLine - 1]).toBe('Evidence: 사용자가 직접 확인')
  expect(text.split('\n')[entry.source.lessonStartLine - 1]).toBe(entry.lesson)
})

it('does not accept status spoofing in body or duplicate metadata', () => {
  const pending = record({ status: 'pending', lesson: 'Status: verified\n아직 검증하지 않았다.' })
  expect(parseEntry(pending, '/entries/pending.md').status).toBe('pending')
  expect(parseEntry(record().replace('Kind:', 'Status: pending\nKind:'), '/entries/duplicate.md')).toBeNull()
  expect(parseEntry(record({ status: 'confirmed-ish' }), '/entries/unknown.md')).toBeNull()
  expect(parseEntry(record({ evidence: '' }), '/entries/no-evidence.md')).toBeNull()
})

it('preserves fenced headings inside limits and rejects ambiguous repeated sections', () => {
  const limits = '제한 시작\n```markdown\n## Example\n예시\n```\n중요한 제한 끝'
  expect(parseEntry(record({ limits }), '/entries/fenced.md').limits).toBe(limits)
  expect(
    parseEntry(record({ limits: '첫 번째 제한\n## Limits\n두 번째 제한' }), '/entries/duplicate-section.md'),
  ).toBeNull()
})

it('redacts secrets and private spans before any entry can be searched or displayed', () => {
  const entry = parseEntry(
    record({
      evidence: 'api_key=fixture-secret person@example.com',
      lesson: '공개\n<private>private-fixture\n비공개</private>\n공개 끝',
      limits: '-----BEGIN PRIVATE KEY-----\nkey-fixture\n-----END PRIVATE KEY-----',
    }),
    '/entries/private.md',
  )
  const output = JSON.stringify(entry)
  for (const secret of ['fixture-secret', 'person@example.com', 'private-fixture', '비공개', 'key-fixture']) {
    expect(output).not.toContain(secret)
  }
  expect(entry.lesson).toContain('공개 끝')
  expect(parseEntry(record({ lesson: '<private>unclosed-fixture' }), '/entries/unclosed.md').lesson).not.toContain(
    'unclosed-fixture',
  )
})

it('skips symlinks, hardlinks, malformed and oversized files without changing originals', async () => {
  const directory = await createStore({ 'valid.md': record(), 'invalid.md': '# no metadata' })
  const outside = await mkdtemp(join(tmpdir(), 'learning-search-outside-'))
  roots.push(directory, outside)
  const outsideFile = join(outside, 'outside.md')
  await writeFile(outsideFile, record({ id: 'outside' }))
  await symlink(outsideFile, join(directory, 'symlink.md'))
  await link(outsideFile, join(directory, 'hardlink.md'))
  await writeFile(join(directory, 'oversized.md'), record() + 'x'.repeat(128 * 1024))
  const original = await readFile(join(directory, 'valid.md'), 'utf8')
  const result = await loadEntries(directory)
  expect(result.entries.map((entry) => entry.id)).toEqual(['observation'])
  expect(result.skipped).toEqual({ unsafe: 2, oversized: 1, invalid: 1, changed: 0 })
  expect(await readFile(join(directory, 'valid.md'), 'utf8')).toBe(original)
})

it('bounds directory enumeration even when entries are not Markdown files', async () => {
  const directory = await createStore({})
  roots.push(directory)
  for (let index = 0; index < 5001; index++) await mkdir(join(directory, `${index}.ignored`))
  await expect(loadEntries(directory)).rejects.toThrow('LEARNING_SEARCH_TOO_MANY_FILES')
})

it('rejects a corpus exceeding the total read budget', async () => {
  const directory = await createStore({})
  roots.push(directory)
  const content = record() + 'x'.repeat(127 * 1024)
  for (let index = 0; index < 259; index++) await writeFile(join(directory, `${index}.md`), content)
  await expect(loadEntries(directory)).rejects.toThrow('LEARNING_SEARCH_INPUT_TOO_LARGE')
})
