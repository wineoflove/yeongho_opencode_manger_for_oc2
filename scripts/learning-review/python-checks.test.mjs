import { expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './application-fixtures.mjs'
import { snapshotTarget } from './application-files.mjs'
import { verifyCommand } from './application-verification.mjs'

it('snapshots Python sources but not virtualenv or bytecode caches', async () => {
  const f = await fixture()
  try {
    const source = join(f.root, 'pkg', 'db.py')
    await mkdir(join(f.root, 'pkg'))
    await writeFile(source, 'VALUE = 1\n')
    expect((await snapshotTarget(f.config, source)).path).toBe(source)
    await mkdir(join(f.root, '.venv'))
    await writeFile(join(f.root, '.venv', 'site.py'), 'x = 1\n')
    await expect(snapshotTarget(f.config, join(f.root, '.venv', 'site.py'))).rejects.toThrow('TARGET_NOT_ALLOWED')
  } finally {
    await f.close()
  }
})

it('captures an isolated python3 unittest run as a test receipt', async () => {
  const f = await fixture()
  try {
    const tests = join(f.root, 'tests')
    await mkdir(tests)
    const target = join(tests, 'test_value.py')
    await writeFile(
      target,
      'import unittest\n\n\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(1 + 1, 2)\n',
    )
    const receipt = await verifyCommand(f.config, {
      argv: ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', tests, '--pattern', 'test_value.py'],
      cwd: f.root,
      kind: 'test',
      scope: 'isolated unittest fixture',
      targets: [target],
    })
    expect(receipt).toMatchObject({ exitCode: 0, kind: 'test', timedOut: false })
  } finally {
    await f.close()
  }
})

it('rejects Python evaluation, package installation and file-rewriting lint modes', async () => {
  const f = await fixture()
  try {
    const request = (argv, kind) =>
      verifyCommand(f.config, { argv, cwd: f.root, kind, scope: 'x', targets: [f.policy] })
    for (const [argv, kind] of [
      [['python3', '-c', 'print(1)', 'unittest'], 'test'],
      [['python3', '-m', 'pip', 'install', 'pytest'], 'test'],
      [['ruff', 'format', f.root], 'lint'],
      [['ruff', 'check', '--fix', f.root], 'lint'],
      [['prettier', '--write', f.policy], 'lint'],
    ])
      await expect(request(argv, kind)).rejects.toThrow('CHECK_COMMAND_NOT_ALLOWED')
  } finally {
    await f.close()
  }
})
