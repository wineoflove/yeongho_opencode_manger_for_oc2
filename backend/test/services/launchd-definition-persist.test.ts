import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as publication from '../../src/services/claude-transfer-activate'
import { launchdDefinitionSteps } from '../../src/services/launchd-definition-persist'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'

const roots: string[] = []
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'launchd-persist-')))
  roots.push(root)
  const agentsDirectory = join(root, 'LaunchAgents')
  const archiveDirectory = join(root, 'archive')
  await mkdir(agentsDirectory, { mode: 0o700 })
  await mkdir(archiveDirectory, { mode: 0o700 })
  const replacements = await Promise.all(
    (['io.wineoflove.ocm.backend', 'io.wineoflove.ocm.frontend'] as const).map(async (label) => {
      const candidate = join(root, `${label}.plist`)
      await writeFile(candidate, `${label}-new`, { mode: 0o600 })
      await writeFile(join(agentsDirectory, `${label}.plist`), `${label}-old`, { mode: 0o600 })
      return {
        label,
        candidate,
        candidateSha256: hash(`${label}-new`),
        originalSha256: hash(`${label}-old`),
      }
    }),
  )
  await writeFile(join(agentsDirectory, 'io.wineoflove.ocm.terminal.plist'), 'terminal-old', { mode: 0o600 })
  const candidate = join(root, 'proxy.plist')
  await writeFile(candidate, 'proxy-new', { mode: 0o600 })
  const input = {
    agentsDirectory,
    archiveDirectory,
    replacements,
    terminalSha256: hash('terminal-old'),
    proxy: { candidate, sha256: hash('proxy-new') },
    assertQuiescent: async () => {},
  }
  return { input, steps: launchdDefinitionSteps(input) }
}

describe('persistent LaunchAgents definitions', () => {
  it('preserves a same-content foreign proxy definition instead of retiring it', async () => {
    const f = await fixture()
    for (const step of f.steps) await step.forward()
    const path = join(f.input.agentsDirectory, 'com.aion.ocm.claude-proxy.plist')
    await rename(path, join(f.input.archiveDirectory, 'owned-proxy.plist'))
    await writeFile(path, 'proxy-new', { mode: 0o600 })
    const step = f.steps.find((entry) => entry.name === 'persist-proxy')
    if (!step) throw new Error('missing-proxy-step')
    await expect(step.rollback()).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    })
    expect(await readFile(path, 'utf8')).toBe('proxy-new')
  })
  it('restores earlier definitions when proxy intent fails before atomic publication', async () => {
    const f = await fixture()
    const original = publication.durableTransferRecord
    vi.spyOn(publication, 'durableTransferRecord').mockImplementation(async (path, record) => {
      if (path.endsWith('.pending') && path.includes('proxy-add-intent-')) {
        await writeFile(path, '{', { mode: 0o600 })
        throw new Error('synthetic-torn-intent')
      }
      await original(path, record)
    })
    await expect(runCutoverSteps({ steps: f.steps, persist: async () => {} })).rejects.toMatchObject({
      rollback: 'verified',
    })
    expect(await readFile(join(f.input.agentsDirectory, 'io.wineoflove.ocm.terminal.plist'), 'utf8')).toBe(
      'terminal-old',
    )
    for (const entry of f.input.replacements)
      expect(await readFile(join(f.input.agentsDirectory, `${entry.label}.plist`), 'utf8')).toBe(`${entry.label}-old`)
  })

  it('resumes terminal restoration after a pending publication link remains', async () => {
    const f = await fixture()
    const step = f.steps.find((entry) => entry.name === 'persist-terminal-retirement')
    if (!step) throw new Error('missing-step')
    await step.forward()
    const temporary = join(f.input.archiveDirectory, '.plugin-pending-11111111-1111-4111-8111-111111111111.bin')
    await writeFile(temporary, 'terminal-old', { mode: 0o600 })
    const target = join(f.input.agentsDirectory, 'io.wineoflove.ocm.terminal.plist')
    await link(temporary, target)
    await step.rollback()
    expect(await readFile(target, 'utf8')).toBe('terminal-old')
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs the new startup set and restores originals on a later failure', async () => {
    const f = await fixture()
    await expect(
      runCutoverSteps({
        steps: [
          ...f.steps,
          {
            name: 'postflight',
            forward: async () => {
              expect((await readdir(f.input.agentsDirectory)).sort()).toEqual([
                'com.aion.ocm.claude-proxy.plist',
                'io.wineoflove.ocm.backend.plist',
                'io.wineoflove.ocm.frontend.plist',
              ])
              throw new Error('synthetic-failure')
            },
            rollback: async () => {},
          },
        ],
        persist: async () => {},
      }),
    ).rejects.toMatchObject({ rollback: 'verified' })
    expect((await readdir(f.input.agentsDirectory)).sort()).toEqual([
      'io.wineoflove.ocm.backend.plist',
      'io.wineoflove.ocm.frontend.plist',
      'io.wineoflove.ocm.terminal.plist',
    ])
    for (const item of f.input.replacements)
      expect(await readFile(join(f.input.agentsDirectory, `${item.label}.plist`), 'utf8')).toBe(`${item.label}-old`)
    expect(await readFile(join(f.input.agentsDirectory, 'io.wineoflove.ocm.terminal.plist'), 'utf8')).toBe(
      'terminal-old',
    )
  })

  it('replays partial file publication and rollback without losing archived originals', async () => {
    const f = await fixture()
    for (const step of f.steps) {
      await step.forward()
      await step.forward()
    }
    for (const step of [...f.steps].reverse()) {
      await step.rollback()
      await step.rollback()
    }
    expect(await readFile(join(f.input.agentsDirectory, 'io.wineoflove.ocm.terminal.plist'), 'utf8')).toBe(
      'terminal-old',
    )
  })

  it('never takes ownership of a preexisting proxy definition, even with matching contents', async () => {
    const f = await fixture()
    const proxy = join(f.input.agentsDirectory, 'com.aion.ocm.claude-proxy.plist')
    await writeFile(proxy, 'proxy-new', { mode: 0o600 })
    await expect(runCutoverSteps({ steps: f.steps, persist: async () => {} })).rejects.toMatchObject({
      rollback: 'verified',
    })
    expect(await readFile(proxy, 'utf8')).toBe('proxy-new')
  })

  it('refuses to restore over a user-edited replacement', async () => {
    const f = await fixture()
    for (const step of f.steps) await step.forward()
    const first = f.steps[0]
    if (!first) throw new Error('missing-step')
    const target = join(f.input.agentsDirectory, 'io.wineoflove.ocm.backend.plist')
    await writeFile(target, 'user-edit')
    await expect(first.rollback()).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    })
    expect(await readFile(target, 'utf8')).toBe('user-edit')
  })
})
