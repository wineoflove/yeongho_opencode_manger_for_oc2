import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { runOwnedCutoverCommand } from '../../src/services/cutover-owned-command'
import { setTimeout as delay } from 'node:timers/promises'

it('returns output only after a successful owned command exits', async () => {
  const result = await runOwnedCutoverCommand({
    executable: '/bin/sh',
    args: ['-c', 'printf synthetic-result'],
    cwd: '/private/tmp',
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 5000,
  })
  expect(result.stdout).toBe('synthetic-result')
  expect(result.exited).toBe(true)
  expect(() => process.kill(result.processGroup, 0)).toThrow()
})

it.each([
  {
    script: 'echo $$ > "$PID_FILE"; sleep 30 & echo $! > "$CHILD_FILE"; wait',
    expected: 'TIMEOUT',
  },
  {
    script: 'echo $$ > "$PID_FILE"; sleep 30 & echo $! > "$CHILD_FILE"; exit 0',
    expected: 'DESCENDANTS_SURVIVED',
  },
])('stops owned child processes before reporting $expected', async ({ script, expected }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-command-')))
  const parent = join(root, 'parent.pid')
  const child = join(root, 'child.pid')
  try {
    await expect(
      runOwnedCutoverCommand({
        executable: '/bin/sh',
        args: ['-c', script],
        cwd: root,
        env: { PATH: '/usr/bin:/bin', PID_FILE: parent, CHILD_FILE: child },
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: expected })
    for (const path of [parent, child]) {
      const pid = Number(await readFile(path, 'utf8'))
      expect(pid).toBeGreaterThan(1)
      expect(() => process.kill(pid, 0)).toThrow()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('terminates the owned live child when process inspection fails without claiming verified group cleanup', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-probe-failure-')))
  const pidFile = join(root, 'pid')
  const childProcess: typeof import('node:child_process') = createRequire(import.meta.url)('node:child_process')
  const original = childProcess.spawnSync
  const probe = vi
    .spyOn(childProcess, 'spawnSync')
    .mockImplementation(() => original('/usr/bin/false', [], { encoding: 'utf8' }))
  syncBuiltinESMExports()
  const cleanup = async () => {
    try {
      const pid = Number(await readFile(pidFile, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 1) {
        process.kill(pid, 'SIGKILL')
        const deadline = Date.now() + 5000
        for (;;) {
          process.kill(pid, 0)
          if (Date.now() >= deadline) throw new Error('owned-fixture-exit-unverified')
          await delay(20)
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code)))) throw error
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    await expect(
      runOwnedCutoverCommand({
        executable: '/bin/sh',
        args: ['-c', 'echo $$ > "$PID_FILE"; exec sleep 30'],
        cwd: root,
        env: { PATH: '/usr/bin:/bin', PID_FILE: pidFile },
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: 'EXIT_UNVERIFIED' })
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(1)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    probe.mockRestore()
    syncBuiltinESMExports()
    await cleanup()
  }
})

it('keeps command diagnostics out of the public error', async () => {
  await expect(
    runOwnedCutoverCommand({
      executable: '/bin/sh',
      args: ['-c', 'printf sensitive-fixture >&2; exit 2'],
      cwd: '/private/tmp',
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 5000,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'COMMAND_FAILED',
  })
})

it('reports an escaped child holding output pipes as unverified instead of waiting forever', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'escaped-command-')))
  const childFile = join(root, 'child.pid')
  let escaped: number | undefined
  const cleanupFixture = async () => {
    if (escaped === undefined) {
      try {
        escaped = Number(await readFile(childFile, 'utf8'))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    if (escaped !== undefined && Number.isSafeInteger(escaped) && escaped > 1) {
      process.kill(escaped, 'SIGTERM')
      const deadline = Date.now() + 5000
      for (;;) {
        try {
          process.kill(escaped, 0)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
          throw error
        }
        if (Date.now() >= deadline) throw new Error('escaped-fixture-exit-unverified')
        await delay(20)
      }
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    await expect(
      runOwnedCutoverCommand({
        executable: process.execPath,
        args: [
          '-e',
          "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn('/bin/sleep',['30'],{detached:true,stdio:['ignore',1,2]});writeFileSync(process.env.CHILD_FILE,String(c.pid));c.unref();",
        ],
        cwd: root,
        env: { PATH: '/usr/bin:/bin', CHILD_FILE: childFile },
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({ code: 'EXIT_UNVERIFIED' })
    escaped = Number(await readFile(childFile, 'utf8'))
    expect(Number.isSafeInteger(escaped) && escaped > 1).toBe(true)
    expect(() => process.kill(escaped ?? 0, 0)).not.toThrow()
  } finally {
    await cleanupFixture()
  }
}, 15000)
