import { createHash } from 'node:crypto'
import { mkdir, link, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { runtimeFilesCutoverSteps } from '../../src/services/runtime-files-cutover-steps'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'
import { openCutoverJournal } from '../../src/services/cutover-journal-store'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

it.each([false, true])(
  'restores runtime files only while installed plugin ownership is intact (foreign=%s)',
  async (foreign) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-files-')))
    try {
      const active = join(root, 'active')
      const state = join(root, 'state')
      const agents = join(active, 'agents')
      const plugins = join(active, 'plugins')
      for (const path of [
        active,
        state,
        agents,
        plugins,
        join(state, 'configs'),
        join(state, 'definitions'),
        join(state, 'model'),
        join(state, 'model-directory'),
        join(state, 'journal'),
      ])
        await mkdir(path, { mode: 0o700 })
      const config = join(active, 'opencode.json')
      const originalConfig = '{"version":1}'
      const candidateConfig = '{"version":2}'
      await writeFile(config, originalConfig, { mode: 0o600 })
      const legacy = 'export const legacy = true'
      const model = 'export const model = "synthetic-model"'
      const modelSource = join(state, 'model-source.js')
      const modelDirectory = join(active, 'native-plugins')
      const modelTarget = join(modelDirectory, 'model.js')
      await writeFile(join(plugins, 'legacy.js'), legacy, { mode: 0o600 })
      await writeFile(join(plugins, 'unrelated.js'), 'preserved', {
        mode: 0o600,
      })
      await writeFile(modelSource, model, { mode: 0o600 })
      const replacements = []
      for (const label of ['io.wineoflove.ocm.backend', 'io.wineoflove.ocm.frontend'] as const) {
        await writeFile(join(agents, `${label}.plist`), 'original-' + label, {
          mode: 0o600,
        })
        const candidate = join(state, `${label}.candidate`)
        await writeFile(candidate, 'candidate-' + label, { mode: 0o600 })
        replacements.push({
          label,
          originalSha256: hash('original-' + label),
          candidate,
          candidateSha256: hash('candidate-' + label),
        })
      }
      await writeFile(join(agents, 'io.wineoflove.ocm.terminal.plist'), 'original-terminal', { mode: 0o600 })
      const proxy = join(state, 'proxy.plist')
      await writeFile(proxy, 'candidate-proxy', { mode: 0o600 })
      const quiet = async () => {}
      const steps = runtimeFilesCutoverSteps({
        assertForwardReady: quiet,
        configurations: [
          {
            name: 'global',
            input: {
              target: config,
              originalSha256: hash(originalConfig),
              candidate: candidateConfig,
              candidateSha256: hash(candidateConfig),
              archiveDirectory: join(state, 'configs'),
              assertQuiescent: quiet,
            },
          },
        ],
        legacyPlugins: {
          sourceDirectory: plugins,
          archiveDirectory: join(state, 'legacy'),
          entries: [{ name: 'legacy.js', sha256: hash(legacy) }],
          assertQuiescent: quiet,
        },
        modelPluginDirectory: {
          target: modelDirectory,
          stateDirectory: join(state, 'model-directory'),
          assertQuiescent: quiet,
        },
        modelPlugin: {
          source: modelSource,
          target: modelTarget,
          sha256: hash(model),
          stateDirectory: join(state, 'model'),
          assertQuiescent: quiet,
        },
        definitions: {
          agentsDirectory: agents,
          archiveDirectory: join(state, 'definitions'),
          replacements,
          terminalSha256: hash('original-terminal'),
          proxy: { candidate: proxy, sha256: hash('candidate-proxy') },
          assertQuiescent: quiet,
        },
      })
      const journal = await openCutoverJournal(join(state, 'journal'))
      let reached = false
      try {
        await expect(
          runCutoverSteps({
            steps: [
              ...steps,
              {
                name: 'postflight',
                forward: async () => {
                  expect(await readFile(modelTarget, 'utf8')).toBe(model)
                  expect(await readFile(config, 'utf8')).toBe(candidateConfig)
                  expect(await readFile(join(agents, 'com.aion.ocm.claude-proxy.plist'), 'utf8')).toBe(
                    'candidate-proxy',
                  )
                  if (foreign) {
                    await rename(modelTarget, join(state, 'owned-model.js'))
                    await writeFile(modelTarget, model, { mode: 0o600 })
                    await link(
                      modelTarget,
                      join(state, 'model/.plugin-pending-11111111-1111-4111-8111-111111111111.bin'),
                    )
                  }
                  reached = true
                  throw new Error('synthetic-postflight-failed')
                },
                rollback: async () => {},
              },
            ],
            persist: journal.persist,
          }),
        ).rejects.toMatchObject({
          rollback: foreign ? 'unverified' : 'verified',
        })
        expect(reached).toBe(true)
        expect(await readFile(join(plugins, 'unrelated.js'), 'utf8')).toBe('preserved')
        expect(await readFile(config, 'utf8')).toBe(foreign ? candidateConfig : originalConfig)
        if (foreign) {
          expect(await readFile(modelTarget, 'utf8')).toBe(model)
          expect(
            await readFile(join(state, 'model/.plugin-pending-11111111-1111-4111-8111-111111111111.bin'), 'utf8'),
          ).toBe(model)
        } else {
          await expect(readFile(modelTarget)).rejects.toMatchObject({
            code: 'ENOENT',
          })
          expect(await readFile(join(plugins, 'legacy.js'), 'utf8')).toBe(legacy)
          expect(await readFile(join(agents, 'io.wineoflove.ocm.terminal.plist'), 'utf8')).toBe('original-terminal')
          for (const entry of replacements)
            expect(await readFile(join(agents, `${entry.label}.plist`), 'utf8')).toBe('original-' + entry.label)
          for (const step of [...steps].reverse()) await step.rollback()
        }
      } finally {
        await journal.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
