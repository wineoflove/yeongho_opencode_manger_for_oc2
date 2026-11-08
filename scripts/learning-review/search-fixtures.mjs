import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function record(overrides = {}) {
  const item = {
    id: 'observation',
    pattern: 'communication.korean',
    status: 'verified',
    title: '한국어 응답 선호',
    conditions: '모든 저장소의 사용자 응답',
    evidence: '사용자가 직접 확인',
    source: '사용자 교정',
    lesson: '영어 자료를 읽어도 한국어로 응답한다.',
    limits: '코드와 명령은 원문을 보존한다.',
    date: '2026-10-08',
    ...overrides,
  }
  return `# ${item.title}\nID: ${item.id}\nPattern-Key: ${item.pattern}\nStatus: ${item.status}\nKind: preference\nObserved-At: ${item.date}\nSource: ${item.source}\nConditions: ${item.conditions}\nEvidence: ${item.evidence}\nRelated: none\n\n## Lesson\n${item.lesson}\n\n## Limits\n${item.limits}\n`
}

export async function createStore(records) {
  const directory = await mkdtemp(join(tmpdir(), 'learning-search-'))
  for (const [name, text] of Object.entries(records)) await writeFile(join(directory, name), text)
  return directory
}
