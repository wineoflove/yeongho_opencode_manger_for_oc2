import { expect, it } from 'bun:test'
import { pypiLatest, resolveInstalledHeadroom } from './headroom.mjs'
import { components } from './collect.mjs'

const plugin = '/tools/headroom/.venv/lib/python3.12/site-packages/headroom/providers/opencode/_dist'
const packagePath = '/tools/headroom/.venv/lib/python3.12/site-packages/headroom'
const loadConfig = async () => JSON.stringify({ plugin: [[plugin, { proxyUrl: 'http://localhost:18787' }]] })

it('reads the distribution using the configured plugin environment instead of PATH Python', async () => {
  const calls = []
  const command = async (...args) => {
    calls.push(args)
    return JSON.stringify({ name: 'headroom-ai', version: '0.41.0', packagePath })
  }
  const installed = await resolveInstalledHeadroom({ configPath: '/config.json', command, loadConfig })
  expect(installed.version).toBe('0.41.0')
  expect(calls[0][0]).toBe('/tools/headroom/.venv/bin/python')
  expect(installed.source).toContain(plugin)
})

it('reads a JSONC Manager configuration with comments and trailing commas', async () => {
  const command = async () => JSON.stringify({ name: 'headroom-ai', version: '0.41.0', packagePath })
  const jsonc = async () => `{\n  // OpenCode 2 config\n  "plugin": [["${plugin}", { "proxyUrl": "http://localhost:18787" }],],\n}`
  expect((await resolveInstalledHeadroom({ configPath: '/opencode.jsonc', command, loadConfig: jsonc })).version).toBe('0.41.0')
})

it('rejects metadata from a different distribution path', async () => {
  const command = async () => JSON.stringify({ name: 'headroom-ai', version: '0.41.0', packagePath: '/other/headroom' })
  await expect(resolveInstalledHeadroom({ configPath: '/config.json', command, loadConfig })).rejects.toThrow(
    'does not belong',
  )
})

it('reports missing or ambiguous configured plugins instead of guessing a version', async () => {
  for (const specs of [[], [plugin, plugin]]) {
    await expect(
      resolveInstalledHeadroom({
        configPath: '/config.json',
        loadConfig: async () => JSON.stringify({ plugin: specs }),
        command: async () => {
          throw new Error('should not run Python')
        },
      }),
    ).rejects.toThrow('exactly one')
  }
})

it('propagates unavailable environment errors without substituting another installation', async () => {
  await expect(
    resolveInstalledHeadroom({
      configPath: '/config.json',
      loadConfig,
      command: async () => {
        throw new Error('ENOENT')
      },
    }),
  ).rejects.toThrow('ENOENT')
})

it('registers headroom in the shared component collection and reporting flow', () => {
  expect(components.find((component) => component.id === 'headroom')).toMatchObject({
    repo: 'headroomlabs-ai/headroom',
    pypi: 'headroom-ai',
  })
})

it('reads the published PyPI version and Python requirement', async () => {
  const request = async (url) => {
    expect(url).toBe('https://pypi.org/pypi/headroom-ai/json')
    return Response.json({ info: { name: 'headroom-ai', version: '0.42.1', requires_python: '>=3.11' } })
  }
  expect(await pypiLatest('headroom-ai', request)).toEqual({ version: '0.42.1', requiresPython: '>=3.11' })
})

it('does not report a latest version when PyPI is unavailable or returns an invalid version', async () => {
  await expect(pypiLatest('headroom-ai', async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503')
  await expect(
    pypiLatest('headroom-ai', async () => Response.json({ info: { name: 'headroom-ai', version: 'unknown' } })),
  ).rejects.toThrow('Invalid PyPI metadata')
})
