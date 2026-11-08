import { applicationEvents, applicationInventory, latestApplications, recordApplication } from './application-store.mjs'
import { snapshotTarget } from './application-files.mjs'
import { verifyReadback } from './application-verification.mjs'
import { probeRuntime, runtimeKind } from './runtime-probe.mjs'
import { openCodeApi } from './opencode.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function loadMode(config, path) {
  const kind = runtimeKind(path)?.kind
  if (kind) return kind
  if (config.policies.some((policy) => policy.path === path)) return 'policy-doc'
  return dirname(path) === SCRIPT_DIR ? 'per-invocation' : 'deployment'
}

const asCheck = ({ kind, command, cwd, scope, evidence }) => ({ kind, command, cwd, scope, evidence, exitCode: 0 })

export async function syncRuntime(config, api) {
  const inventory = await applicationInventory(config)
  const latest = latestApplications(await applicationEvents(config))
  const probes = new Map()
  const prepared = new Map()
  const result = { verified: [], notRequired: [], reloadPending: [], unsupported: [], failed: [] }
  for (const item of inventory.items.filter((entry) => entry.state === 'applied' && entry.runtime === 'pending')) {
    const event = latest.get(item.patternKey)
    const kinds = event.targets.map((target) => loadMode(config, target.path))
    const probed = (path) => ['agent', 'skill'].includes(loadMode(config, path))
    const fileOnly = !kinds.some((kind) => ['agent', 'skill'].includes(kind))
    if (!event.targets.length || kinds.includes('deployment')) {
      result.unsupported.push({ patternKey: item.patternKey, targets: event.targets.map((target) => target.path) })
      continue
    }
    try {
      for (const target of event.targets) {
        if (probed(target.path) && !probes.has(target.path))
          probes.set(target.path, await probeRuntime(config, target.path, api ?? openCodeApi()))
        if (!prepared.has(target.path))
          prepared.set(target.path, {
            snapshot: await snapshotTarget(config, target.path),
            readback: await verifyReadback(config, target.path, 'runtime 확인 시점 파일 전체 읽기'),
          })
      }
      const mismatch = event.targets.find((target) => probed(target.path) && !probes.get(target.path).matches)
      if (mismatch) {
        result.reloadPending.push({ patternKey: item.patternKey, path: mismatch.path })
        continue
      }
      const targets = event.input.targets.map((target, index) => {
        const current = prepared.get(event.targets[index].path)
        return {
          snapshot: current.snapshot.snapshot,
          afterHash: current.snapshot.sha256,
          change: 'existing',
          requirement: target.requirement,
          ...(target.anchor ? { anchor: target.anchor } : {}),
        }
      })
      const policyPaths = new Set(config.policies.map((policy) => policy.path))
      const checks = [
        ...event.targets.flatMap((target) =>
          probed(target.path)
            ? [asCheck(prepared.get(target.path).readback), asCheck(probes.get(target.path))]
            : policyPaths.has(target.path)
              ? [asCheck(prepared.get(target.path).readback)]
              : [],
        ),
        ...(event.targets.some((target) => !policyPaths.has(target.path))
          ? event.input.checks.filter((check) => check.kind !== 'readback' && check.kind !== 'runtime')
          : []),
      ]
      const recorded = await recordApplication(config, {
        ...event.input,
        expectedRevision: event.revision,
        evidence: [event.artifact, ...event.input.evidence].slice(0, 20),
        targets,
        checks,
        runtime: fileOnly
          ? {
              status: 'not_required',
              reason: kinds.includes('per-request')
                ? 'AGENTS.md는 OpenCode instruction 로더가 새 요청마다 파일에서 다시 읽는다(서버 재로딩 불필요). 이미 시작된 응답에는 미적용.'
                : kinds.includes('per-invocation')
                  ? '학습 리뷰 스크립트는 예약 작업이 매번 bun으로 새로 실행하므로 상주 프로세스 재시작이 필요 없다.'
                  : '절차 문서는 예약 작업이 실행 시작 때 파일에서 직접 읽는다. 서버 재로딩 불필요.',
              evidence: [],
            }
          : {
              status: 'verified',
              reason:
                '실행 중 서버가 제공하는 본문이 현재 파일 본문과 일치함을 읽기 전용으로 확인. reload/restart 없음.',
              evidence: event.targets
                .filter((target) => probed(target.path))
                .map((target) => probes.get(target.path).evidence),
            },
      })
      result[fileOnly ? 'notRequired' : 'verified'].push({ patternKey: item.patternKey, revision: recorded.revision })
    } catch (error) {
      result.failed.push({
        patternKey: item.patternKey,
        code: /^[A-Z_]+$/.test(error.message) ? error.message : 'RUNTIME_SYNC_FAILED',
      })
    }
  }
  return {
    probes: [...probes.values()].map(({ command, matches, evidence, targets }) => ({
      command,
      matches,
      evidence,
      targets,
    })),
    counts: Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])),
    ...result,
  }
}
