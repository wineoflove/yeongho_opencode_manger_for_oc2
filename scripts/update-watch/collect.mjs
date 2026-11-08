import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from '../../shared/src/utils/jsonc.ts'
import { openCodeApi } from '../learning-review/opencode.mjs'
import { promisify } from 'node:util'
import { digest } from './digest.mjs'
import { pypiLatest, resolveInstalledHeadroom } from './headroom.mjs'
import {
  bumpKind,
  newerVersions,
  normalize,
  parseStable,
  previousInLine,
  selectNoteVersions,
  truncate,
} from './versions.mjs'

const exec = promisify(execFile)
export const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const workspace = process.env.WORKSPACE_PATH || `${root}/workspace`
export const stateDir = `${workspace}/.opencode/update-watch`
export const paths = {
  state: `${stateDir}/state.json`,
  latest: `${stateDir}/latest.json`,
  digest: `${stateDir}/latest.md`,
  config: `${stateDir}/config.json`,
}
const opencodeConfigs = ['opencode.jsonc', 'opencode.json'].map((name) => `${workspace}/.config/opencode/${name}`)
const limits = { recent: 6, body: 6000, commits: 60, releasePages: 5 }
const NOISE = /^(chore|ci|tests?|docs|build|style|release)\b|^Merge |^sync release versions/i

async function command(file, args, timeout = 60000) {
  const { stdout } = await exec(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

async function gh(path) {
  return JSON.parse(await command('gh', ['api', path]))
}

async function opencodeConfig() {
  for (const path of opencodeConfigs) if (existsSync(path)) return path
  throw new Error('No Manager OpenCode configuration file found')
}

async function pluginSpecs() {
  const config = parseJsonc(await readFile(await opencodeConfig(), 'utf8'))
  return (config.plugin ?? []).map((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry
    return spec.startsWith('/') ? basename(spec) : spec
  })
}

function parseVersion(value, label) {
  const version = /\d+\.\d+\.\d+/.exec(String(value ?? ''))?.[0]
  if (!version) throw new Error(`${label} returned no version`)
  return version
}

async function runningServerVersion() {
  return parseVersion((await openCodeApi().server.info()).version, 'OpenCode server info')
}

async function shellCliVersion() {
  return parseVersion(await command('opencode', ['--version']), 'opencode --version')
}

export async function resolveInstalledOpenCode({ server = runningServerVersion, cli = shellCliVersion } = {}) {
  const [running, shell] = await Promise.allSettled([server(), cli()])
  const shellVersion = shell.status === 'fulfilled' ? shell.value : null
  if (running.status === 'fulfilled') {
    const mismatch = shellVersion && shellVersion !== running.value ? `; PATH opencode --version ${shellVersion}` : ''
    return { version: running.value, source: `running OpenCode 2 server info${mismatch}` }
  }
  if (shellVersion) return { version: shellVersion, source: 'opencode --version (running server unreachable)' }
  throw new Error('OpenCode version unavailable from the running server and opencode --version')
}

async function installedManager() {
  const git = (args) => command('git', ['-C', root, ...args])
  const tag = await git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'])
  const ahead = await git(['rev-list', '--count', `${tag}..HEAD`])
  const head = await git(['rev-parse', '--short', 'HEAD'])
  return { version: normalize(tag), source: `fork HEAD ${head}, upstream ${tag} + ${ahead} commits` }
}

async function installedOmo() {
  const spec = (await pluginSpecs()).find((entry) => entry.startsWith('oh-my-openagent@'))
  const version = normalize(spec?.split('@').pop())
  if (!version) throw new Error('oh-my-openagent pin not found in opencode.json')
  return { version, source: 'opencode.json plugin pin' }
}

async function npmLatest(name) {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`)
  const manifest = await response.json()
  return {
    version: manifest.version,
    peerDependencies: manifest.peerDependencies ?? {},
    engines: manifest.engines ?? {},
    opencodePlugin: manifest.dependencies?.['@opencode-ai/plugin'] ?? null,
  }
}

export const components = [
  { id: 'oc', name: 'OpenCode', repo: 'anomalyco/opencode', installed: () => resolveInstalledOpenCode() },
  { id: 'ocm', name: 'OpenCode Manager', repo: 'chriswritescode-dev/opencode-manager', installed: installedManager },
  {
    id: 'omo',
    name: 'oh-my-openagent',
    repo: 'code-yeongyu/oh-my-openagent',
    installed: installedOmo,
    npm: 'oh-my-openagent',
  },
  {
    id: 'headroom',
    name: 'headroom',
    repo: 'headroomlabs-ai/headroom',
    installed: async () => resolveInstalledHeadroom({ configPath: await opencodeConfig(), command }),
    pypi: 'headroom-ai',
  },
]

async function stableTags(repo) {
  const output = await command('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}.git`])
  return output
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter((tag) => parseStable(tag))
}

async function stableReleases(repo, baseline) {
  const found = []
  for (let page = 1; page <= limits.releasePages; page++) {
    const batch = await gh(`repos/${repo}/releases?per_page=100&page=${page}`)
    const stable = batch.filter((release) => !release.draft && !release.prerelease && parseStable(release.tag_name))
    found.push(...stable)
    if (batch.length < 100 || stable.some((release) => newerVersions([release.tag_name], baseline).length === 0)) break
  }
  return found
}

export function catalog(tags, releases) {
  const entries = new Map(tags.map((tag) => [normalize(tag), { tag }]))
  for (const release of releases) entries.set(normalize(release.tag_name), { tag: release.tag_name, release })
  return entries
}

async function commitSubjects(repo, base, head) {
  const data = await gh(`repos/${repo}/compare/${base}...${head}`)
  const subjects = data.commits
    .map((item) => item.commit.message.split('\n')[0])
    .filter((subject) => !NOISE.test(subject))
  return { totalCommits: data.total_commits ?? data.commits.length, subjects: subjects.slice(-limits.commits) }
}

async function note(repo, entries, version) {
  const { tag, release } = entries.get(version)
  if (release?.body?.trim()) {
    return {
      version,
      source: 'release',
      url: release.html_url,
      publishedAt: release.published_at,
      body: truncate(release.body, limits.body),
    }
  }
  const previous = previousInLine(version, [...entries.keys()])
  if (!previous)
    return {
      version,
      source: 'none',
      url: `https://github.com/${repo}/tree/${tag}`,
      reason: '새 라인의 첫 버전이며 릴리스 노트가 없습니다',
    }
  const base = entries.get(previous).tag
  return {
    version,
    source: 'commits',
    url: `https://github.com/${repo}/compare/${base}...${tag}`,
    ...(await commitSubjects(repo, base, tag)),
  }
}

async function collectComponent(component, reported) {
  const installed = await component.installed()
  const [tags, releases] = await Promise.all([
    stableTags(component.repo),
    stableReleases(component.repo, installed.version),
  ])
  const entries = catalog(tags, releases)
  const pending = newerVersions([...entries.keys()], installed.version)
  const fresh = pending.filter((version) => !reported.includes(version))
  const selected = selectNoteVersions(fresh, [...entries.keys()], limits.recent)
  const notes = []
  for (const version of selected) notes.push(await note(component.repo, entries, version))
  const latest = pending.at(-1) ?? installed.version
  return {
    id: component.id,
    name: component.name,
    repo: component.repo,
    installed,
    latest,
    bump: bumpKind(installed.version, latest),
    pending: pending.map((version) => ({
      version,
      tag: entries.get(version).tag,
      publishedAt: entries.get(version).release?.published_at ?? null,
      isNew: fresh.includes(version),
    })),
    fresh,
    notes,
    notesOmitted: fresh.filter((version) => !selected.includes(version)),
    ...(component.npm ? { npmLatest: await npmLatest(component.npm) } : {}),
    ...(component.pypi ? { pypiLatest: await pypiLatest(component.pypi) } : {}),
  }
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomic(path, text) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(`${path}.tmp`, text, { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export async function writeJson(path, value) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function collect(now = new Date()) {
  const state = await readJson(paths.state, { reported: {} })
  const results = []
  for (const component of components) {
    try {
      results.push(await collectComponent(component, state.reported?.[component.id] ?? []))
    } catch (error) {
      results.push({
        id: component.id,
        name: component.name,
        repo: component.repo,
        error: String(error?.message ?? error).slice(0, 500),
      })
    }
  }
  return {
    checkedAt: now.toISOString(),
    plugins: await pluginSpecs(),
    hasFresh: results.some((item) => item.fresh?.length),
    components: results,
  }
}

if (import.meta.main) {
  process.umask(0o077)
  const result = await collect()
  await writeJson(paths.latest, result)
  await writeAtomic(paths.digest, digest(result))
  const summary = result.components.map((item) =>
    item.error
      ? { id: item.id, error: item.error }
      : {
          id: item.id,
          installed: item.installed.version,
          latest: item.latest,
          bump: item.bump,
          pending: item.pending.length,
          fresh: item.fresh.length,
        },
  )
  process.stdout.write(
    `${JSON.stringify({ digest: paths.digest, checkedAt: result.checkedAt, hasFresh: result.hasFresh, components: summary })}\n`,
  )
  if (result.components.every((item) => item.error)) process.exitCode = 1
}
