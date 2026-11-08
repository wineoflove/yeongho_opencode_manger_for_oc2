import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadEntries } from './search-entries.mjs'
import { formatResults, queryTerms, rankEntries, resultOptions } from './search-rank.mjs'

export async function searchLearnings({ query, entries, includePending = false, limit = 5, maxChars = 6000 }) {
  queryTerms(query)
  const options = resultOptions({ includePending, limit, maxChars })
  const loaded = await loadEntries(
    entries ?? fileURLToPath(new URL('../../workspace/.opencode/learnings/entries/', import.meta.url)),
  )
  const ranked = rankEntries(loaded.entries, query, includePending)
  return formatResults(loaded, ranked, options)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      entries: { type: 'string' },
      'include-pending': { type: 'boolean', default: false },
      limit: { type: 'string', default: '5' },
      'max-chars': { type: 'string', default: '6000' },
      help: { type: 'boolean', default: false },
      batch: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(
      '사용법: bun --no-env-file scripts/learning-review/search.mjs "한국어 응답" [--include-pending] [--limit 5] [--max-chars 6000]\n--entries는 명시적인 오프라인 사본·테스트용 입력 경로입니다. 기본값은 전역 학습 entries입니다.\n',
    )
    process.stdout.write('--batch reads a JSON array of up to 50 queries (500 characters each) from stdin.\n')
    return
  }
  if (values.batch) {
    let queries
    try {
      queries = JSON.parse(readFileSync(0, 'utf8'))
    } catch {
      throw new Error('LEARNING_SEARCH_INVALID_BATCH')
    }
    if (
      positionals.length ||
      !Array.isArray(queries) ||
      queries.length > 50 ||
      queries.some((query) => typeof query !== 'string' || query.length > 500)
    )
      throw new Error('LEARNING_SEARCH_INVALID_BATCH')
    const options = resultOptions({
      limit: Number(values.limit),
      maxChars: Number(values['max-chars']),
      includePending: values['include-pending'],
    })
    const loaded = await loadEntries(
      values.entries ?? fileURLToPath(new URL('../../workspace/.opencode/learnings/entries/', import.meta.url)),
    )
    const results = queries.map((query) => {
      try {
        return {
          query,
          ids: rankEntries(loaded.entries, query, options.includePending)
            .results.slice(0, options.limit)
            .map(({ entry }) => entry.id),
        }
      } catch (error) {
        if (error.message !== 'LEARNING_SEARCH_INVALID_QUERY') throw error
        return { query, ids: [], error: 'LEARNING_SEARCH_INVALID_QUERY' }
      }
    })
    process.stdout.write(`${JSON.stringify(results)}\n`)
    return
  }
  process.stdout.write(
    await searchLearnings({
      query: positionals.join(' '),
      entries: values.entries,
      includePending: values['include-pending'],
      limit: Number(values.limit),
      maxChars: Number(values['max-chars']),
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      error instanceof Error && /^LEARNING_SEARCH_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'LEARNING_SEARCH_FAILED'
    process.stderr.write(`${JSON.stringify({ error: code })}\n`)
    process.exitCode = 1
  })
}
