import { test, expect } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveVerificationCommand } from './verification-command.mjs'

test('pins installed tools and refuses basename impersonation and interpreter options', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verify-command-')))
  try {
    const config = { codeRoots: [root] }
    await writeFile(join(root, 'node'), 'synthetic-impostor')
    for (const argv of [
      [join(root, 'node'), '--test'],
      ['node', '--eval=1', 'test'],
      ['node', '-e1', 'test'],
      ['node', '--import=/synthetic/hook.mjs', '--test'],
      ['bun', 'arbitrary.mjs', 'test'],
      ['pnpm', 'exec', 'arbitrary', 'test'],
    ])
      await expect(resolveVerificationCommand(config, { argv, kind: 'test' }, root)).rejects.toThrow(
        'CHECK_COMMAND_NOT_ALLOWED',
      )
    expect(
      await resolveVerificationCommand(
        config,
        {
          argv: ['bun', '--no-env-file', 'test', 'sample.test.mjs'],
          kind: 'test',
        },
        root,
      ),
    ).toBe(await realpath('/Users/yeonghokim/.local/bin/bun'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
