import { expect, it } from 'bun:test'
import { catalog, resolveInstalledOpenCode } from './collect.mjs'

it('prefers release metadata over a bare tag for the same version', () => {
  const release = { tag_name: 'v1.18.34', body: 'notes' }
  const entries = catalog(['v1.18.34', 'v2.0.0'], [release])
  expect(entries.get('1.18.34')).toEqual({ tag: 'v1.18.34', release })
  expect(entries.get('2.0.0')).toEqual({ tag: 'v2.0.0' })
})

it('retains parallel major releases and tag-only versions without relying on latest', () => {
  const v1 = { tag_name: 'v1.19.6', body: 'V1 notes' }
  const v2 = { tag_name: 'v2.3.2', body: 'V2 notes' }
  const entries = catalog(['v1.19.6', 'v2.3.2', 'v2.3.3'], [v2, v1])
  expect([...entries.keys()]).toEqual(['1.19.6', '2.3.2', '2.3.3'])
  expect(entries.get('1.19.6')).toEqual({ tag: 'v1.19.6', release: v1 })
  expect(entries.get('2.3.2')).toEqual({ tag: 'v2.3.2', release: v2 })
  expect(entries.get('2.3.3')).toEqual({ tag: 'v2.3.3' })
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
