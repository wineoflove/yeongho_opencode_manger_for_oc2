import { constants } from 'node:fs'
import { lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { z } from 'zod'

const readySchema = z.object({ version: z.literal(1) }).strict()

export class ClaudeProxyGateError extends Error {
  constructor(readonly code: 'PROXY_BLOCKED' | 'GATE_UNAVAILABLE') {
    super(code)
    this.name = 'ClaudeProxyGateError'
  }
}

export class ClaudeProxyGate {
  private blocked = false
  private readonly requests = new Set<AbortController>()

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new ClaudeProxyGateError('GATE_UNAVAILABLE')
  }

  static async initialize(directory: string): Promise<ClaudeProxyGate> {
    const gate = new ClaudeProxyGate(directory)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ version: 1 }), { mode: 0o600, flag: 'wx' })
    return gate
  }

  async acquire(signal: AbortSignal) {
    signal.throwIfAborted()
    await this.check()
    if (this.blocked) throw new ClaudeProxyGateError('PROXY_BLOCKED')
    signal.throwIfAborted()
    const controller = new AbortController()
    this.requests.add(controller)
    return {
      signal: AbortSignal.any([signal, controller.signal]),
      release: () => {
        controller.abort()
        return this.requests.delete(controller)
      },
    }
  }

  async deny(): Promise<void> {
    this.blocked = true
    for (const request of this.requests) request.abort()
    try {
      const marker = await open(
        join(this.directory, 'blocked'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await marker.writeFile(
          JSON.stringify({
            version: 1,
            reason: 'access-denied',
            observedAt: Date.now(),
          }),
        )
        await marker.sync()
      } finally {
        await marker.close()
      }
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return
      throw new ClaudeProxyGateError('GATE_UNAVAILABLE')
    }
  }

  private async check(): Promise<void> {
    if (this.blocked) throw new ClaudeProxyGateError('PROXY_BLOCKED')
    try {
      const directory = await lstat(this.directory)
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
        throw new ClaudeProxyGateError('GATE_UNAVAILABLE')
      const ready = await open(
        join(this.directory, 'ready.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const metadata = await ready.stat()
        if (
          !metadata.isFile() ||
          metadata.uid !== process.getuid?.() ||
          metadata.nlink !== 1 ||
          (metadata.mode & 0o077) !== 0 ||
          metadata.size > 256
        )
          throw new ClaudeProxyGateError('GATE_UNAVAILABLE')
        readySchema.parse(JSON.parse(await ready.readFile('utf8')))
      } finally {
        await ready.close()
      }
      try {
        await lstat(join(this.directory, 'blocked'))
        this.blocked = true
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    } catch (error) {
      this.blocked = true
      for (const request of this.requests) request.abort()
      if (error instanceof ClaudeProxyGateError) throw error
      throw new ClaudeProxyGateError('GATE_UNAVAILABLE')
    }
    if (this.blocked) {
      for (const request of this.requests) request.abort()
      throw new ClaudeProxyGateError('PROXY_BLOCKED')
    }
  }
}
