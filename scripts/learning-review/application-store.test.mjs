import { expect, it } from 'bun:test'
import { writeFile, readFile, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, addEntry, decision } from './application-fixtures.mjs'
import { readBounded, saveArtifact, sha256, snapshotTarget } from './application-files.mjs'
import { applicationInventory, recordApplication } from './application-store.mjs'
import { prepareApplications } from './application-plan.mjs'
import { verifyCommand, verifyReadback } from './application-verification.mjs'

it('does not infer implementation from verified and queues verified records for assessment', async () => {
  const f = await fixture()
  try {
    const plan = await prepareApplications(f.config, 'daily')
    expect(plan.counts).toEqual({ unassessed: 1 })
    expect(plan.selected[0].learningStatuses).toEqual(['verified'])
  } finally {
    await f.close()
  }
})

it('requires actual targets and check receipts instead of model success prose', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    await expect(recordApplication(f.config, { ...input, checks: [] })).rejects.toThrow()
    const invented = await saveArtifact(f.config, 'checks', { passed: true })
    await expect(
      recordApplication(f.config, { ...input, checks: [{ ...input.checks[0], evidence: invented }] }),
    ).rejects.toThrow()
    expect((await applicationInventory(f.config)).counts).toEqual({ unassessed: 1 })
  } finally {
    await f.close()
  }
})

it('keeps implementation and runtime separate and detects subsequent source drift', async () => {
  const f = await fixture()
  try {
    const original = await readFile(join(f.store, 'entries/first.md'), 'utf8')
    await recordApplication(f.config, await decision(f))
    expect((await applicationInventory(f.config)).items[0]).toMatchObject({ state: 'applied', runtime: 'pending' })
    await writeFile(f.policy, '# changed\n')
    expect((await applicationInventory(f.config)).items[0]).toMatchObject({ state: 'drifted', runtime: 'unconfirmed' })
    expect(await readFile(join(f.store, 'entries/first.md'), 'utf8')).toBe(original)
  } finally {
    await f.close()
  }
})

it('rejects stale revisions and simultaneous same-revision writers', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    const outcomes = await Promise.allSettled([recordApplication(f.config, input), recordApplication(f.config, input)])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    await expect(recordApplication(f.config, input)).rejects.toThrow('APPLICATION_REVISION_CONFLICT')
  } finally {
    await f.close()
  }
})

it('excludes unchanged blocked candidates before selecting three actionable items', async () => {
  const f = await fixture()
  try {
    const input = await decision(f, {
      decision: 'blocked',
      targets: [],
      checks: [],
      unblockWhen: 'owner finishes work',
    })
    await recordApplication(f.config, input)
    for (let index = 0; index < 4; index++) await addEntry(f.config, `later${index}`, `test.later${index}`)
    const plan = await prepareApplications(f.config, 'daily')
    expect(plan.blocked).toBe(1)
    expect(plan.selected).toHaveLength(3)
    expect(plan.selected.every((item) => item.patternKey !== 'test.first')).toBe(true)
    await addEntry(f.config, 'new-source', 'test.first')
    expect((await applicationInventory(f.config)).items.find((item) => item.patternKey === 'test.first').state).toBe(
      'source_changed',
    )
  } finally {
    await f.close()
  }
})

it('groups declared aliases without changing or deleting original records', async () => {
  const f = await fixture()
  try {
    await addEntry(f.config, 'second', 'test.alias', 'pending')
    f.config.aliases['test.alias'] = 'test.first'
    const status = await applicationInventory(f.config)
    expect(status.patterns).toBe(1)
    expect(status.items[0].entryIds).toEqual(['first', 'second'])
  } finally {
    await f.close()
  }
})

it('rejects target hash drift between check and record', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    await writeFile(f.policy, '# altered\n')
    await expect(recordApplication(f.config, input)).rejects.toThrow('TARGET_HASH_MISMATCH')
  } finally {
    await f.close()
  }
})

it('archives original policy text and refuses protected section modifications', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    const text = (await readBounded(f.policy)).replace('Keep approval boundaries.', 'Remove all boundaries.')
    await writeFile(f.policy, text)
    input.targets[0] = { ...input.targets[0], afterHash: sha256(text), change: 'modified' }
    await expect(recordApplication(f.config, input)).rejects.toThrow('PROTECTED_POLICY_CHANGED')
    const saved = JSON.parse(await readFile(join(f.store, input.targets[0].snapshot), 'utf8'))
    expect(saved.text).toContain('Keep approval boundaries.')
  } finally {
    await f.close()
  }
})

it('rejects symlinks, hardlinks and oversized snapshots', async () => {
  const f = await fixture()
  try {
    const symbolic = join(f.root, 'symbol.md')
    await symlink(f.policy, symbolic)
    await expect(readBounded(symbolic)).rejects.toThrow()
    const hard = join(f.root, 'hard.md')
    await link(f.policy, hard)
    await expect(readBounded(hard)).rejects.toThrow('UNSAFE_OR_OVERSIZED_FILE')
    const big = join(f.root, 'big.md')
    await writeFile(big, 'x'.repeat(262145))
    await expect(snapshotTarget(f.config, big)).rejects.toThrow('UNSAFE_OR_OVERSIZED_FILE')
  } finally {
    await f.close()
  }
})

it('binds captured failing command results to refusal of applied status', async () => {
  const f = await fixture()
  try {
    const test = join(f.root, 'fixture.test.mjs')
    await writeFile(
      test,
      "import { test } from 'node:test'; import { strict as assert } from 'node:assert'; test('fails', () => assert.equal(1, 2))",
    )
    const receipt = await verifyCommand(f.config, {
      argv: ['node', '--test', test],
      cwd: f.root,
      scope: 'fixture failure',
      kind: 'test',
      targets: [f.policy],
    })
    expect(receipt.exitCode).toBe(1)
    const input = await decision(f)
    input.checks = [
      {
        kind: receipt.kind,
        command: receipt.command,
        cwd: receipt.cwd,
        scope: receipt.scope,
        evidence: receipt.evidence,
        exitCode: 0,
      },
    ]
    await expect(recordApplication(f.config, input)).rejects.toThrow('CHECK_RECEIPT_MISMATCH')
  } finally {
    await f.close()
  }
})

it('requires an executed check for code and rejects install commands', async () => {
  const f = await fixture()
  try {
    const path = join(f.root, 'feature.mjs')
    await writeFile(path, 'export const value = 1\n')
    const snapshot = await snapshotTarget(f.config, path)
    const receipt = await verifyReadback(f.config, path, 'file only')
    const input = await decision(f)
    input.targets = [{ ...input.targets[0], snapshot: snapshot.snapshot, afterHash: snapshot.sha256 }]
    input.checks = [
      {
        kind: receipt.kind,
        command: receipt.command,
        cwd: receipt.cwd,
        scope: receipt.scope,
        evidence: receipt.evidence,
        exitCode: 0,
      },
    ]
    await expect(recordApplication(f.config, input)).rejects.toThrow('CODE_APPLICATION_REQUIRES_EXECUTED_CHECK')
    await expect(
      verifyCommand(f.config, { argv: ['pnpm', 'install'], cwd: f.root, kind: 'test', scope: 'bad', targets: [path] }),
    ).rejects.toThrow('CHECK_COMMAND_NOT_ALLOWED')
  } finally {
    await f.close()
  }
})

it('tracks a policy rule by its anchor so unrelated policy edits do not drift it', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    input.targets[0].anchor = 'Use focused checks.'
    await recordApplication(f.config, input)
    await writeFile(f.policy, `${await readBounded(f.policy)}\n## Extra\nAnother rule.\n`)
    expect((await applicationInventory(f.config)).items[0].state).toBe('applied')
    await writeFile(f.policy, (await readBounded(f.policy)).replace('Use focused checks.', 'Use broad checks.'))
    expect((await applicationInventory(f.config)).items[0].state).toBe('drifted')
  } finally {
    await f.close()
  }
})

it('drifts when the anchored rule line changes around the anchor or moves into a code block', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    input.targets[0].anchor = 'Use focused checks.'
    await recordApplication(f.config, input)
    const original = await readBounded(f.policy)
    await writeFile(f.policy, original.replace('Use focused checks.', 'Do not follow this rule: Use focused checks.'))
    expect((await applicationInventory(f.config)).items[0].state).toBe('drifted')
    await writeFile(f.policy, original.replace('Use focused checks.', '```\nUse focused checks.\n```'))
    expect((await applicationInventory(f.config)).items[0].state).toBe('drifted')
    await writeFile(f.policy, original)
    expect((await applicationInventory(f.config)).items[0].state).toBe('applied')
  } finally {
    await f.close()
  }
})

it('rejects an anchor that matches more than one rule line', async () => {
  const f = await fixture()
  try {
    await writeFile(f.policy, `${await readBounded(f.policy)}\n## Again\nUse focused checks.\n`)
    const input = await decision(f)
    input.targets[0].anchor = 'Use focused checks.'
    await expect(recordApplication(f.config, input)).rejects.toThrow('ANCHOR_NOT_UNIQUE')
  } finally {
    await f.close()
  }
})

it('reports source changes ahead of evidence changes and target drift ahead of both', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    await recordApplication(f.config, input)
    await writeFile(join(f.store, input.evidence[0]), '{}')
    await addEntry(f.config, 'second-source', 'test.first')
    expect((await applicationInventory(f.config)).items[0].state).toBe('source_changed')
    await writeFile(f.policy, '# replaced\n')
    expect((await applicationInventory(f.config)).items[0].state).toBe('drifted')
  } finally {
    await f.close()
  }
})

it('rejects anchors that are missing from the policy or attached to code targets', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    input.targets[0].anchor = 'This rule does not exist.'
    await expect(recordApplication(f.config, input)).rejects.toThrow('ANCHOR_NOT_FOUND')
    const path = join(f.root, 'feature.mjs')
    await writeFile(path, 'export const value = 1\n')
    const snapshot = await snapshotTarget(f.config, path)
    input.targets = [
      {
        snapshot: snapshot.snapshot,
        afterHash: snapshot.sha256,
        change: 'existing',
        requirement: 'code',
        anchor: 'export const value',
      },
    ]
    await expect(recordApplication(f.config, input)).rejects.toThrow('ANCHOR_POLICY_ONLY')
  } finally {
    await f.close()
  }
})

it('allows formatter-only blank lines but preserves protected rule content', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    const next = (await readBounded(f.policy)).replace('## Safety\n', '## Safety\n\n')
    await writeFile(f.policy, next)
    const receipt = await verifyReadback(f.config, f.policy, 'blank-line-only formatting')
    input.targets[0] = { ...input.targets[0], afterHash: sha256(next), change: 'modified' }
    input.checks = [
      {
        kind: receipt.kind,
        command: receipt.command,
        cwd: receipt.cwd,
        scope: receipt.scope,
        evidence: receipt.evidence,
        exitCode: 0,
      },
    ]
    expect((await recordApplication(f.config, input)).decision).toBe('applied')
  } finally {
    await f.close()
  }
})
