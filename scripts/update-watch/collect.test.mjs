import { expect, it } from 'bun:test'
import { catalog, resolveInstalledOpenCode } from './collect.mjs'

it('prefers release metadata over a bare tag for the same version', () => {
  const release = { tag_name: 'v1.18.34', body: 'notes' }
  const entries = catalog(['v1.18.34', 'v2.0.0'], [release])
  expect(entries.get('1.18.34')).toEqual({ tag: 'v1.18.34', release })
  expect(entries.get('2.0.0')).toEqual({ tag: 'v2.0.0' })
})

const fail = (message) => async () => {
  throw new Error(message)
}

it('reports the running server version and notes a different PATH binary', async () => {
  const installed = await resolveInstalledOpenCode({ server: async () => '1.19.0', cli: async () => '1.18.35' })
  expect(installed).toEqual({
    version: '1.19.0',
    source: 'running OpenCode 2 server info; PATH opencode --version 1.18.35',
  })
})

it('omits the PATH note when both installations agree or the CLI is unavailable', async () => {
  expect(await resolveInstalledOpenCode({ server: async () => '1.19.0', cli: async () => '1.19.0' })).toEqual({
    version: '1.19.0',
    source: 'running OpenCode 2 server info',
  })
  expect(await resolveInstalledOpenCode({ server: async () => '1.19.0', cli: fail('missing') })).toEqual({
    version: '1.19.0',
    source: 'running OpenCode 2 server info',
  })
})

it('falls back to the PATH binary only when the running server is unreachable', async () => {
  expect(await resolveInstalledOpenCode({ server: fail('ECONNREFUSED'), cli: async () => '1.18.35' })).toEqual({
    version: '1.18.35',
    source: 'opencode --version (running server unreachable)',
  })
  await expect(resolveInstalledOpenCode({ server: fail('ECONNREFUSED'), cli: fail('missing') })).rejects.toThrow(
    'OpenCode version unavailable',
  )
})
