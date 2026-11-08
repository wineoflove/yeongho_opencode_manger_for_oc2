import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runLearningScript } from '../../src/services/learnings/script-runner'

function findBun(): string | null {
  try {
    return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const bunPath = findBun()
const scriptsDir = path.resolve(__dirname, '../../../scripts')

const entry = `# 한국어 응답 선호
ID: observation
Pattern-Key: communication.korean
Status: verified
Kind: preference
Observed-At: 2026-10-08
Source: 사용자 교정
Conditions: 모든 저장소의 사용자 응답
Evidence: 사용자가 직접 확인
Related: none

## Lesson
영어 자료를 읽어도 한국어로 응답한다.

## Limits
코드와 명령은 원문을 보존한다.
`

describe('runLearningScript', () => {
  const roots: string[] = []
  const previousScriptsDir = process.env.OCM_SCRIPTS_DIR

  afterEach(async () => {
    process.env.OCM_SCRIPTS_DIR = previousScriptsDir
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it.skipIf(bunPath === null)('runs search.mjs against temporary entries and returns its JSON', async () => {
    const entries = await mkdtemp(path.join(tmpdir(), 'ocm-learning-runner-'))
    roots.push(entries)
    await writeFile(path.join(entries, 'observation.md'), entry)
    process.env.OCM_SCRIPTS_DIR = scriptsDir

    const result = await runLearningScript({
      script: 'search.mjs',
      args: ['한국어 응답', '--entries', entries],
      bunPath: bunPath ?? undefined,
    })

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as { results: Array<{ id: string }> }
    expect(parsed.results.map((hit) => hit.id)).toEqual(['observation'])
    expect(await readdir(entries)).toEqual(['observation.md'])
  })

  it.skipIf(bunPath === null)('kills the script and reports timedOut when it exceeds the timeout', async () => {
    const scripts = await mkdtemp(path.join(tmpdir(), 'ocm-learning-scripts-'))
    roots.push(scripts)
    await mkdir(path.join(scripts, 'learning-review'))
    await writeFile(
      path.join(scripts, 'learning-review', 'lint.mjs'),
      'await new Promise((resolve) => setTimeout(resolve, 10000))\n',
    )
    process.env.OCM_SCRIPTS_DIR = scripts

    const result = await runLearningScript({
      script: 'lint.mjs',
      args: [],
      timeoutMs: 300,
      bunPath: bunPath ?? undefined,
    })

    expect(result.timedOut).toBe(true)
  })
})
