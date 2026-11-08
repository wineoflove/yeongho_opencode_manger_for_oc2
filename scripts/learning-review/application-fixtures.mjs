import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, saveArtifact, snapshotTarget, sha256, readBounded } from './application-files.mjs'
import { verifyReadback } from './application-verification.mjs'

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ocm-learning-application-'))
  const store = join(root, 'learnings')
  const policy = join(root, 'assistant.md')
  await mkdir(join(store, 'entries'), { recursive: true })
  await writeFile(policy, '# Assistant\n\n## Safety\nKeep approval boundaries.\n\n## Work\nUse focused checks.\n')
  const config = Config.parse({
    version: 1,
    store,
    codeRoots: [root],
    policies: [{ id: 'assistant', path: policy, mutable: true, protectedHeadings: ['Safety'] }],
  })
  await writeFile(join(store, 'application-config.json'), JSON.stringify(config))
  await addEntry(config, 'first', 'test.first')
  return { root, store, policy, config, close: () => rm(root, { recursive: true, force: true }) }
}

export async function addEntry(config, id, patternKey, status = 'verified') {
  await writeFile(
    join(config.store, 'entries', `${id}.md`),
    `# ${id}\nID: ${id}\nPattern-Key: ${patternKey}\nStatus: ${status}\nKind: solution\nObserved-At: 2026-01-01\nSource: fixture\nConditions: isolated\nEvidence: prior passing checks\nRelated: none\n\n## Lesson\nUse a check.\n\n## Limits\nNo deployment evidence.\n`,
  )
}

export async function decision(f, overrides = {}) {
  const snapshot = await snapshotTarget(f.config, f.policy)
  const receipt = await verifyReadback(f.config, f.policy, 'isolated policy text')
  const { kind, command, cwd, scope, evidence } = receipt
  const note = await saveArtifact(f.config, 'notes', { review: 'verified local text and scope' })
  return {
    patternKey: 'test.first',
    entryIds: ['first'],
    expectedRevision: 0,
    decision: 'applied',
    summary: '정책 반영',
    rationale: '파일 내용 대조',
    evidence: [note],
    targets: [
      {
        snapshot: snapshot.snapshot,
        afterHash: sha256(await readBounded(f.policy)),
        change: 'existing',
        requirement: 'focused checks',
      },
    ],
    checks: [{ kind, command, cwd, scope, evidence, exitCode: 0 }],
    runtime: { status: 'pending', reason: 'runtime not restarted', evidence: [] },
    ...overrides,
  }
}
