import { basename, dirname, resolve } from 'node:path'
import { readBounded, saveArtifact, sha256, targetPath } from './application-files.mjs'
import { VerificationReceipt } from './application-verification.mjs'
import { openCodeApi } from './opencode.mjs'

const stripFrontmatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()

export function runtimeKind(path) {
  if (basename(path) === 'SKILL.md') return { kind: 'skill', name: basename(dirname(path)) }
  if (basename(dirname(path)) === 'agents' && path.endsWith('.md'))
    return { kind: 'agent', name: basename(path, '.md') }
  if (basename(path) === 'AGENTS.md') return { kind: 'per-request', name: path }
  return null
}

async function loadedText(config, target, kind, api) {
  const location = { directory: config.runtime.directory }
  if (kind.kind === 'agent')
    return (await api.agent.list({ location })).data.find((agent) => agent.name === kind.name || agent.id === kind.name)
      ?.system
  return (await api.skill.list({ location })).data.find((skill) => resolve(skill.path) === target.path)?.content
}

/** Compares a policy file's body with the agent or skill text the running OpenCode 2 server serves, without reloading it. */
export async function probeRuntime(config, path, client) {
  if (!config.runtime) throw new Error('RUNTIME_NOT_CONFIGURED')
  const api = client ?? openCodeApi()
  const target = await targetPath(config, path)
  const kind = runtimeKind(target.path)
  if (!kind || !['agent', 'skill'].includes(kind.kind)) throw new Error('UNSUPPORTED_RUNTIME_TARGET')
  const startedAt = new Date().toISOString()
  const text = await readBounded(target.path)
  const listed = await loadedText(config, target, kind, api)
  if (typeof listed !== 'string') throw new Error('RUNTIME_TARGET_NOT_LOADED')
  const matches = stripFrontmatter(listed) === stripFrontmatter(text)
  if (sha256(await readBounded(target.path)) !== sha256(text)) throw new Error('CHECK_TARGET_CHANGED')
  const receipt = VerificationReceipt.parse({
    version: 1,
    origin: 'runtime-probe',
    kind: 'runtime',
    command: `runtime-probe ${kind.kind}:${kind.name}`,
    cwd: config.codeRoots[0],
    scope: `실행 중 OpenCode 2 서버가 Manager 내부 프록시로 제공하는 ${kind.kind} 본문과 파일 본문 일치 여부. 읽기 전용이며 reload 없음.`,
    exitCode: matches ? 0 : 2,
    timedOut: false,
    outputTruncated: false,
    output: JSON.stringify({
      loadedSha256: sha256(stripFrontmatter(listed)),
      fileBodySha256: sha256(stripFrontmatter(text)),
    }),
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: [{ path: target.path, sha256: sha256(text) }],
  })
  return { ...receipt, matches, evidence: await saveArtifact(config, 'checks', receipt) }
}
