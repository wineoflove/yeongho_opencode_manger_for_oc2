import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, addEntry, decision } from './application-fixtures.mjs'
import { applicationInventory, recordApplication } from './application-store.mjs'
import { prepareApplications } from './application-plan.mjs'
import { saveArtifact, snapshotTarget } from './application-files.mjs'
import { verifyCommand } from './application-verification.mjs'

it('drives prepare and status through the public CLI without marking verified as applied', async () => {
  const f = await fixture()
  try {
    const cli = fileURLToPath(new URL('./applications.mjs', import.meta.url))
    const run = (command) =>
      spawnSync(
        process.execPath,
        ['--no-env-file', cli, command, '--config', join(f.store, 'application-config.json')],
        { cwd: f.root, encoding: 'utf8' },
      )
    const prepared = run('prepare')
    expect(prepared.status).toBe(0)
    expect(JSON.parse(prepared.stdout)).toMatchObject({ counts: { unassessed: 1 }, actionable: 1 })
    const status = run('status')
    expect(status.status).toBe(0)
    expect(JSON.parse(status.stdout).items[0].state).toBe('unassessed')
  } finally {
    await f.close()
  }
})

it('selects new or changed learnings before an older backlog of planned confirmations', async () => {
  const f = await fixture()
  try {
    const note = await saveArtifact(f.config, 'notes', { review: 'code confirmation pending' })
    const planned = {
      patternKey: 'test.first',
      entryIds: ['first'],
      expectedRevision: 0,
      decision: 'planned',
      summary: 'confirm current code',
      rationale: 'implementation recorded earlier',
      evidence: [note],
      runtime: { status: 'not_required', reason: 'no runtime change yet' },
    }
    await recordApplication(f.config, planned)
    await addEntry(f.config, 'newer', 'test.newer')
    const plan = await prepareApplications(f.config, 'daily')
    expect(plan.selected.map((item) => item.patternKey)).toEqual(['test.newer', 'test.first'])
  } finally {
    await f.close()
  }
})

it('invalidates applied evidence when a stored receipt is changed', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    await recordApplication(f.config, input)
    await writeFile(join(f.store, input.evidence[0]), '{}')
    expect((await applicationInventory(f.config)).items[0].state).toBe('evidence_changed')
  } finally {
    await f.close()
  }
})

it('rejects an added target that has no matching check', async () => {
  const f = await fixture()
  try {
    const input = await decision(f)
    const other = join(f.root, 'other.mjs')
    await writeFile(other, 'export const value = 2\n')
    const snapshot = await snapshotTarget(f.config, other)
    input.targets.push({
      snapshot: snapshot.snapshot,
      afterHash: snapshot.sha256,
      change: 'existing',
      requirement: 'other behavior',
    })
    await expect(recordApplication(f.config, input)).rejects.toThrow('UNCHECKED_TARGET')
  } finally {
    await f.close()
  }
})

it('requires separate runtime approval before starting a runtime check', async () => {
  const f = await fixture()
  try {
    await expect(
      verifyCommand(f.config, {
        argv: ['node', 'probe.mjs', '--check'],
        cwd: f.root,
        kind: 'runtime',
        scope: 'runtime',
        targets: [f.policy],
      }),
    ).rejects.toThrow('RUNTIME_APPROVAL_REQUIRED')
  } finally {
    await f.close()
  }
})

it('captures approved local runtime evidence separately from implementation evidence', async () => {
  const f = await fixture()
  try {
    const probe = join(f.root, 'probe.mjs')
    await writeFile(probe, 'process.stdout.write("isolated probe complete")')
    const approval = await saveArtifact(f.config, 'notes', { approval: 'fixture-only runtime check' })
    const receipt = await verifyCommand(f.config, {
      argv: ['node', probe, '--check'],
      cwd: f.root,
      kind: 'runtime',
      scope: 'fixture only, not a deployed service',
      targets: [f.policy],
      approvalEvidence: approval,
    })
    const input = await decision(f)
    input.runtime = { status: 'verified', reason: 'fixture scope', evidence: [receipt.evidence] }
    input.checks.push({
      kind: 'runtime',
      command: receipt.command,
      cwd: receipt.cwd,
      scope: receipt.scope,
      evidence: receipt.evidence,
      exitCode: 0,
    })
    await recordApplication(f.config, input)
    expect((await applicationInventory(f.config)).items[0].runtime).toBe('verified')
  } finally {
    await f.close()
  }
})
