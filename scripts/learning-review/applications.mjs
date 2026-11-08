import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, readBounded, snapshotTarget } from './application-files.mjs'
import { applicationInventory, recordApplication } from './application-store.mjs'
import { prepareApplications } from './application-plan.mjs'
import { recordPolicyReview } from './policy-review.mjs'
import { verifyCommand, verifyReadback } from './application-verification.mjs'
import { probeRuntime } from './runtime-probe.mjs'
import { syncRuntime } from './runtime-sync.mjs'
import { editClaims } from './edit-claims.mjs'

export const defaultConfigPath = join(
  process.env.WORKSPACE_PATH || fileURLToPath(new URL('../../workspace', import.meta.url)),
  '.opencode/learnings/application-config.json',
)

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: defaultConfigPath },
      mode: { type: 'string', default: 'daily' },
      input: { type: 'string' },
      path: { type: 'string' },
      scope: { type: 'string' },
      self: { type: 'string' },
    },
  })
  const config = await loadConfig(values.config)
  const input = async () => {
    if (!values.input) throw new Error('INPUT_FILE_REQUIRED')
    return JSON.parse(await readBounded(values.input, 4 * 1024 * 1024))
  }
  switch (positionals[0]) {
    case 'prepare':
      return prepareApplications(config, values.mode)
    case 'status':
      return applicationInventory(config)
    case 'snapshot':
      return snapshotTarget(config, values.path ?? '')
    case 'record':
      return recordApplication(config, await input())
    case 'review':
      return recordPolicyReview(config, await input())
    case 'verify':
      return verifyCommand(config, await input())
    case 'readback':
      return verifyReadback(config, values.path ?? '', values.scope ?? '파일 읽기 확인')
    case 'claims':
      return editClaims(config, values.path ?? '', { self: values.self })
    case 'runtime-probe':
      return probeRuntime(config, values.path ?? '')
    case 'runtime-sync':
      return syncRuntime(config)
    default:
      throw new Error('USE_PREPARE_STATUS_SNAPSHOT_VERIFY_READBACK_RECORD_REVIEW_CLAIMS_RUNTIME')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.name : 'Error', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'LEARNING_APPLICATION_FAILED' })}\n`,
    )
    process.exitCode = 1
  }
}
