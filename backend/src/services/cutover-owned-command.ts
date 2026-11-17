import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export class CutoverCommandError extends Error {
  constructor(
    readonly code:
      | 'INVALID_COMMAND'
      | 'SPAWN_FAILED'
      | 'TIMEOUT'
      | 'COMMAND_FAILED'
      | 'OUTPUT_LIMIT'
      | 'DESCENDANTS_SURVIVED'
      | 'EXIT_UNVERIFIED',
  ) {
    super(code)
    this.name = 'CutoverCommandError'
  }
}

function groupMembers(group: number): number[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (result.status !== 0 || result.stderr.trim()) throw new CutoverCommandError('EXIT_UNVERIFIED')
  const members: number[] = []
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) throw new CutoverCommandError('EXIT_UNVERIFIED')
    if (Number(match[2]) === group) members.push(Number(match[1]))
  }
  return members
}

async function stopGroup(group: number) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!groupMembers(group).length) return
    try {
      process.kill(-group, signal)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        throw new CutoverCommandError('EXIT_UNVERIFIED')
    }
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!groupMembers(group).length) return
      await delay(50)
    }
  }
  throw new CutoverCommandError('EXIT_UNVERIFIED')
}

export async function runOwnedCutoverCommand(input: {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}) {
  if (
    !isAbsolute(input.executable) ||
    !isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 3600000
  )
    throw new CutoverCommandError('INVALID_COMMAND')
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let bytes = 0
  let overflow = false
  let overflowWake: () => void = () => {}
  const outputLimit = new Promise<'output-limit'>((resolve) => {
    overflowWake = () => resolve('output-limit')
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 4 * 1024 * 1024) {
      overflow = true
      overflowWake()
      return
    }
    stdout += chunk
  })
  child.stderr.resume()
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', () => reject(new CutoverCommandError('SPAWN_FAILED')))
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const confirmClosed = async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new CutoverCommandError('EXIT_UNVERIFIED')), 5000)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), input.timeoutMs)
  })
  try {
    const result = await Promise.race([exited, timeout, outputLimit])
    const group = child.pid
    if (group === undefined || group <= 1) throw new CutoverCommandError('SPAWN_FAILED')
    if (result === 'timeout' || result === 'output-limit') {
      await stopGroup(group)
      await confirmClosed()
      throw new CutoverCommandError(result === 'timeout' ? 'TIMEOUT' : 'OUTPUT_LIMIT')
    }
    if (groupMembers(group).length) {
      await stopGroup(group)
      await confirmClosed()
      throw new CutoverCommandError('DESCENDANTS_SURVIVED')
    }
    await confirmClosed()
    if (overflow) throw new CutoverCommandError('OUTPUT_LIMIT')
    if (result !== 0) throw new CutoverCommandError('COMMAND_FAILED')
    return { stdout, processGroup: group, exited: true as const }
  } catch (error) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (signalError) {
        if (!(signalError instanceof Error && 'code' in signalError && signalError.code === 'ESRCH'))
          throw new CutoverCommandError('EXIT_UNVERIFIED')
      }
      await confirmClosed()
    }
    throw error
  } finally {
    clearTimeout(timer)
    child.stdout.destroy()
    child.stderr.destroy()
  }
}
