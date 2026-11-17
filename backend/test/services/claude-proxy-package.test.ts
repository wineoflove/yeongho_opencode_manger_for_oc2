import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { prepareClaudeProxyPackage } from '../../src/services/claude-proxy-package'
import { loadClaudeProxyClient } from '../../src/services/claude-proxy-config'
import { loadClaudeInference } from '../../src/services/claude-inference-config'

describe('Claude proxy service packaging', () => {
  it('prepares isolated keys and loader-compatible configuration without importing accounts', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'proxy-package-'))
    try {
      const binary = join(parent, 'fixture-binary')
      await writeFile(binary, 'fixture-not-executable')
      const destination = join(parent, 'service & files')
      const manifest = await prepareClaudeProxyPackage({
        destination,
        binary,
        binarySha256: createHash('sha256').update('fixture-not-executable').digest('hex'),
        port: 5117,
      })
      expect(manifest.status).toBe('prepared-not-activated')
      expect(await readdir(join(destination, 'auths'))).toEqual([])
      const environment = JSON.parse(await readFile(join(destination, 'manager-environment.json'), 'utf8'))
      expect(await loadClaudeProxyClient(environment)).toBeDefined()
      expect(await loadClaudeInference(environment)).toBeDefined()
      const keys = await Promise.all(
        ['ingress', 'upstream', 'management'].map((name) => readFile(join(destination, `keys/${name}.key`), 'utf8')),
      )
      expect(new Set(keys).size).toBe(3)
      const plist = await readFile(join(destination, 'com.aion.ocm.claude-proxy.plist'), 'utf8')
      expect(plist).toContain('service &amp; files')
      for (const key of keys) {
        expect(plist).not.toContain(key)
        expect(JSON.stringify(manifest)).not.toContain(key)
      }
      expect((await stat(join(destination, 'keys/management.key'))).mode & 0o077).toBe(0)
      await expect(
        prepareClaudeProxyPackage({
          destination,
          binary,
          binarySha256: manifest.binarySha256,
          port: 5117,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      expect(
        await Promise.all(
          ['ingress', 'upstream', 'management'].map((name) => readFile(join(destination, `keys/${name}.key`), 'utf8')),
        ),
      ).toEqual(keys)
    } finally {
      await rm(parent, { recursive: true })
    }
  })
  it('does not create a package for an unverified binary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'proxy-package-'))
    try {
      const binary = join(parent, 'binary')
      await writeFile(binary, 'unexpected')
      await expect(
        prepareClaudeProxyPackage({
          destination: join(parent, 'service'),
          binary,
          binarySha256: '0'.repeat(64),
          port: 5117,
        }),
      ).rejects.toMatchObject({ code: 'BINARY_MISMATCH' })
      expect(await readdir(parent)).toEqual(['binary'])
    } finally {
      await rm(parent, { recursive: true })
    }
  })
})
