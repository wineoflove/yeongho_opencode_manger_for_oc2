import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLaunchdDefinition, snapshotLaunchdDefinition } from '../../src/services/claude-launchd-definition'
import { readPrivateTransferFile } from '../../src/services/claude-transfer-stage'

const label = 'com.aion.ocm.maintenance-ingress'
const text = JSON.stringify({
  Label: label,
  ProgramArguments: ['/usr/bin/true'],
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'launchd-definition-')))
  const state = join(root, 'state')
  const source = join(root, 'source.plist')
  await mkdir(state, { mode: 0o700 })
  await writeFile(source, text, { mode: 0o600 })
  return { root, state, source }
}

describe('launchd definition source permissions', () => {
  it.each([0o600, 0o644])(
    'accepts owned non-writable-by-others source mode %s and makes a private snapshot',
    async (mode) => {
      const f = await fixture()
      try {
        await chmod(f.source, mode)
        const snapshot = await snapshotLaunchdDefinition(f.source, label, f.state)
        expect(await readFile(snapshot.path, 'utf8')).toBe(text)
        expect((await stat(snapshot.path)).mode & 0o777).toBe(0o600)
        expect((await stat(f.source)).mode & 0o777).toBe(mode)
        await expect(assertLaunchdDefinition(snapshot.path, snapshot.sha256)).resolves.toBeUndefined()
        await expect(assertLaunchdDefinition(f.source, snapshot.sha256)).resolves.toBeUndefined()
      } finally {
        await rm(f.root, { recursive: true })
      }
    },
  )

  it.each([0o620, 0o602, 0o666])('rejects externally writable source mode %s', async (mode) => {
    const f = await fixture()
    try {
      await chmod(f.source, mode)
      await expect(snapshotLaunchdDefinition(f.source, label, f.state)).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('rejects symbolic and hard-linked definitions', async () => {
    const f = await fixture()
    try {
      const alias = join(f.root, 'alias.plist')
      await symlink(f.source, alias)
      await expect(snapshotLaunchdDefinition(alias, label, f.state)).rejects.toThrow()
      await link(f.source, join(f.root, 'hardlink.plist'))
      await expect(snapshotLaunchdDefinition(f.source, label, f.state)).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })

  it('does not relax the credential-file reader', async () => {
    const f = await fixture()
    try {
      await chmod(f.source, 0o644)
      await expect(readPrivateTransferFile(f.source)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
    } finally {
      await rm(f.root, { recursive: true })
    }
  })
})
