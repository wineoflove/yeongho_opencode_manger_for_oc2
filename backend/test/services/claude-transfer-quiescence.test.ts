import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { assertClaudeTransferStopped, captureClaudeProcessTree } from '../../src/services/claude-transfer-quiescence'

describe('real process quiescence probes', () => {
  it('rejects a live process instead of treating an unused port as sufficient', async () => {
    await expect(
      assertClaudeTransferStopped({
        processIDs: [process.pid],
        ports: [5117],
        launchdServices: [],
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_PRESENT' })
  })
  it('retains the owned process identity and checks the listener independently after exit', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const closed = once(child, 'close')
    const server = createServer()
    try {
      await once(child.stdout, 'data')
      if (!child.pid) throw new Error('missing_child')
      expect(captureClaudeProcessTree(child.pid)).toContain(child.pid)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing_listener')
      const scope = {
        processIDs: [child.pid],
        ports: [address.port],
        launchdServices: [`gui/${process.getuid?.()}/com.aion.ocm.fixture-${child.pid}`],
      }
      child.kill('SIGTERM')
      await closed
      await expect(assertClaudeTransferStopped(scope)).rejects.toMatchObject({
        code: 'LISTENER_PRESENT',
      })
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await expect(assertClaudeTransferStopped(scope)).resolves.toBeUndefined()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
  it('rejects an empty observation scope', async () => {
    await expect(
      assertClaudeTransferStopped({
        processIDs: [],
        ports: [],
        launchdServices: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
  })
})
