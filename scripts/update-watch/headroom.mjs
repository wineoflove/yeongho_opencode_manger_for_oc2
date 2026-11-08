import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { parseStable } from './versions.mjs'
import { parseJsonc } from '../../shared/src/utils/jsonc.ts'

export async function resolveInstalledHeadroom({ configPath, command, loadConfig = readFile }) {
  const config = parseJsonc(await loadConfig(configPath, 'utf8'))
  const specs = (config.plugin ?? []).map((entry) => (Array.isArray(entry) ? entry[0] : entry))
  const matches = specs.filter((spec) => typeof spec === 'string' && isAbsolute(spec) && spec.includes('/headroom/'))
  if (matches.length !== 1) throw new Error('Expected exactly one configured local headroom plugin')
  const plugin = matches[0]
  let environment = dirname(plugin)
  while (environment !== parse(environment).root && !environment.endsWith('/.venv')) environment = dirname(environment)
  if (!environment.endsWith('/.venv')) throw new Error('Configured headroom plugin has no identifiable .venv')
  const python = join(environment, 'bin/python')
  const script = [
    'import importlib.metadata as m, json',
    "d=m.distribution('headroom-ai')",
    "print(json.dumps({'name':d.metadata['Name'],'version':d.version,'packagePath':str(d.locate_file('headroom').resolve())}))",
  ].join('; ')
  const metadata = JSON.parse(await command(python, ['-c', script]))
  if (metadata.name !== 'headroom-ai' || !parseStable(metadata.version)) {
    throw new Error('Invalid installed headroom-ai distribution metadata')
  }
  if (typeof metadata.packagePath !== 'string' || !plugin.startsWith(`${metadata.packagePath}/`)) {
    throw new Error('Configured headroom plugin does not belong to the inspected distribution')
  }
  return { version: metadata.version, source: `headroom-ai distribution via ${python}; configured plugin ${plugin}` }
}

export async function pypiLatest(name, request = fetch) {
  const response = await request(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`PyPI registry HTTP ${response.status}`)
  const { info } = await response.json()
  if (info?.name !== name || !parseStable(info.version)) throw new Error(`Invalid PyPI metadata for ${name}`)
  return { version: info.version, requiresPython: info.requires_python ?? null }
}
