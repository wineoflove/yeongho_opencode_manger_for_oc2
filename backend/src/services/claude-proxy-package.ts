import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { ClaudeProxyGate } from './claude-proxy-gate'

export type ClaudeProxyPackageInput = {
  readonly destination: string
  readonly binary: string
  readonly binarySha256: string
  readonly port: number
}

export class ClaudeProxyPackageError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'BINARY_MISMATCH') {
    super(code)
    this.name = 'ClaudeProxyPackageError'
  }
}

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export async function prepareClaudeProxyPackage(input: ClaudeProxyPackageInput) {
  if (
    !isAbsolute(input.destination) ||
    !isAbsolute(input.binary) ||
    !/^[a-f0-9]{64}$/.test(input.binarySha256) ||
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    [5003, 5551].includes(input.port)
  )
    throw new ClaudeProxyPackageError('INVALID_INPUT')
  if ((await realpath(dirname(input.destination))) !== dirname(input.destination))
    throw new ClaudeProxyPackageError('INVALID_INPUT')
  const source = await readFile(input.binary)
  if (sha256(source) !== input.binarySha256) throw new ClaudeProxyPackageError('BINARY_MISMATCH')
  await mkdir(input.destination, { mode: 0o700 })
  const root = input.destination
  for (const path of ['bin', 'auths', 'logs', 'keys', 'home', 'cache', 'state', 'tmp'])
    await mkdir(join(root, path), { mode: 0o700 })
  const binary = join(root, 'bin/cli-proxy-api')
  await copyFile(input.binary, binary, constants.COPYFILE_EXCL)
  await chmod(binary, 0o700)
  if (sha256(await readFile(binary)) !== input.binarySha256) throw new ClaudeProxyPackageError('BINARY_MISMATCH')
  const upstreamKey = randomBytes(32).toString('hex')
  const managementKey = randomBytes(32).toString('hex')
  for (const [name, value] of Object.entries({
    ingress: randomBytes(32).toString('hex'),
    upstream: upstreamKey,
    management: managementKey,
  }))
    await writeFile(join(root, `keys/${name}.key`), value, {
      mode: 0o600,
      flag: 'wx',
    })
  await ClaudeProxyGate.initialize(join(root, 'gate'))
  const config = {
    'config-version': 8,
    server: { host: '0.0.0.0', port: input.port },
    management: {
      'allow-remote': false,
      'secret-key': managementKey,
      'disable-control-panel': true,
    },
    access: { 'api-keys': [upstreamKey] },
    oauth: { 'auth-dir': join(root, 'auths') },
    routing: {
      strategy: 'round-robin',
      'session-affinity': false,
      retry: {
        'request-retry': 0,
        'max-retry-credentials': 1,
        'max-retry-interval': 0,
      },
    },
    requests: {
      streaming: { 'bootstrap-retries': 0 },
      'passthrough-headers': true,
    },
    upstream: { claude: { 'server-side-fallback': false } },
    observability: {
      logs: {
        debug: false,
        'logging-to-file': true,
        'request-log': false,
        'logs-max-total-size-mb': 32,
      },
      usage: { 'usage-statistics-enabled': false },
    },
  }
  await writeFile(join(root, 'config.yaml'), JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: 'wx',
  })
  const environment = {
    OCM_CLAUDE_PROXY_URL: `http://127.0.0.1:${input.port}`,
    OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: join(root, 'keys/management.key'),
    OCM_CLAUDE_INFERENCE_KEY_FILE: join(root, 'keys/ingress.key'),
    OCM_CLAUDE_PROXY_API_KEY_FILE: join(root, 'keys/upstream.key'),
    OCM_CLAUDE_PROXY_GATE_DIRECTORY: join(root, 'gate'),
  }
  await writeFile(join(root, 'manager-environment.json'), JSON.stringify(environment, null, 2), {
    mode: 0o600,
    flag: 'wx',
  })
  const label = 'com.aion.ocm.claude-proxy'
  const user = execFileSync('/usr/bin/id', ['-un'], {
    encoding: 'utf8',
  }).trim()
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>-config</string><string>${xml(join(root, 'config.yaml'))}</string><string>-local-model</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(join(root, 'home'))}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>TMPDIR</key><string>${xml(join(root, 'tmp'))}</string><key>USER</key><string>${xml(user)}</string><key>LOGNAME</key><string>${xml(user)}</string></dict>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(root, 'logs/stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'logs/stderr.log'))}</string>
</dict></plist>`
  await writeFile(join(root, `${label}.plist`), plist, {
    mode: 0o600,
    flag: 'wx',
  })
  const manifest = {
    version: 1,
    status: 'prepared-not-activated',
    label,
    binarySha256: input.binarySha256,
    port: input.port,
    credentialCount: 0,
    createdAt: new Date().toISOString(),
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
  return manifest
}
