import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assessLegacyDataWindow } from '../../src/services/legacy-data-window'
import type { MaintenanceLaunchdUnit } from '../../src/services/claude-maintenance-launchd'

it('rechecks a new listener despite cached stopped state and admits the window only after it exits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-data-window-')))
  const database = join(root, 'fixture.db')
  await writeFile(database, 'synthetic-unopened-database', { mode: 0o600 })
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const closed = once(child, 'close')
  const server = createServer()
  try {
    await once(child.stdout, 'data')
    if (!child.pid) throw new Error('missing_child')
    server.listen(0, '0.0.0.0')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing_listener')
    const unit: MaintenanceLaunchdUnit = {
      label: `com.aion.ocm.fixture-${randomUUID()}`,
      port: address.port,
      pids: [child.pid],
      registered: false,
      survivingDescendants: 0,
    }
    const input = { units: [unit], databases: [database] }
    await expect(assessLegacyDataWindow(input)).resolves.toEqual({
      eligible: false,
      reason: 'PROCESS_PRESENT',
    })
    child.kill('SIGTERM')
    await closed
    await expect(assessLegacyDataWindow(input)).resolves.toEqual({
      eligible: false,
      reason: 'LISTENER_PRESENT',
    })
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await expect(assessLegacyDataWindow(input)).resolves.toEqual({
      eligible: true,
      surviving: 0,
    })
    delete unit.survivingDescendants
    await expect(assessLegacyDataWindow(input)).resolves.toEqual({
      eligible: false,
      reason: 'DESCENDANTS_UNVERIFIED',
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
})
