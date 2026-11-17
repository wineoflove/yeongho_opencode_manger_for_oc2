import { spawnSync } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export type ClaudeTransferProcessScope = {
  readonly processIDs: readonly number[]
  readonly ports: readonly number[]
  readonly launchdServices: readonly string[]
}

export class ClaudeQuiescenceError extends Error {
  constructor(
    readonly code: 'INVALID_SCOPE' | 'PROCESS_PRESENT' | 'LISTENER_PRESENT' | 'SERVICE_REGISTERED' | 'PROBE_FAILED',
  ) {
    super(code)
    this.name = 'ClaudeQuiescenceError'
  }
}

function command(binary: string, args: readonly string[]) {
  if (!isAbsolute(binary)) throw new ClaudeQuiescenceError('PROBE_FAILED')
  const result = spawnSync(binary, [...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status === null) throw new ClaudeQuiescenceError('PROBE_FAILED')
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export function captureClaudeProcessTree(rootPID: number): readonly number[] {
  if (!Number.isInteger(rootPID) || rootPID <= 1) throw new ClaudeQuiescenceError('INVALID_SCOPE')
  const result = command('/bin/ps', ['-axo', 'pid=,ppid='])
  if (result.status !== 0 || result.stderr) throw new ClaudeQuiescenceError('PROBE_FAILED')
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (!match) throw new ClaudeQuiescenceError('PROBE_FAILED')
      return { pid: Number(match[1]), parent: Number(match[2]) }
    })
  if (!rows.some((row) => row.pid === rootPID)) throw new ClaudeQuiescenceError('PROBE_FAILED')
  const selected = new Set([rootPID])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows)
      if (selected.has(row.parent) && !selected.has(row.pid)) {
        selected.add(row.pid)
        changed = true
      }
  }
  return [...selected]
}

export type ProcessIdentity = {
  readonly pid: number
  readonly started: string
}

export function captureProcessIdentities(pids: readonly number[]): ProcessIdentity[] {
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 1)) throw new ClaudeQuiescenceError('INVALID_SCOPE')
  if (!pids.length) return []
  const result = command('/bin/ps', ['-o', 'pid=,lstart=', '-p', [...new Set(pids)].join(',')])
  if (result.stderr.trim() || (result.status !== 0 && (result.status !== 1 || result.stdout.trim())))
    throw new ClaudeQuiescenceError('PROBE_FAILED')
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line)
      if (!match) throw new ClaudeQuiescenceError('PROBE_FAILED')
      return { pid: Number(match[1]), started: match[2] ?? '' }
    })
}

export function listenerProcessIDs(port: number): number[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ClaudeQuiescenceError('INVALID_SCOPE')
  const result = command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (result.stderr.trim() || (result.status !== 0 && (result.status !== 1 || result.stdout.trim())))
    throw new ClaudeQuiescenceError('PROBE_FAILED')
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      if (!/^\d+$/.test(line.trim())) throw new ClaudeQuiescenceError('PROBE_FAILED')
      return Number(line.trim())
    })
}

export function survivingIdentities(identities: readonly ProcessIdentity[]): ProcessIdentity[] {
  const current = captureProcessIdentities(identities.map((identity) => identity.pid))
  return identities.filter((identity) =>
    current.some((candidate) => candidate.pid === identity.pid && candidate.started === identity.started),
  )
}

export async function assertOwnedRuntimeStopped(scope: {
  readonly identities: readonly ProcessIdentity[]
  readonly ports: readonly number[]
  readonly launchdServices: readonly string[]
}): Promise<void> {
  if (!scope.identities.length || !scope.ports.length || !scope.launchdServices.length)
    throw new ClaudeQuiescenceError('INVALID_SCOPE')
  assertServicesAbsent(scope.launchdServices)
  if (survivingIdentities(scope.identities).length) throw new ClaudeQuiescenceError('PROCESS_PRESENT')
  assertPortsFree(scope.ports)
}

export async function assertDatabaseFilesUnheld(databases: readonly string[]): Promise<void> {
  if (!databases.length || databases.some((path) => !isAbsolute(path))) throw new ClaudeQuiescenceError('INVALID_SCOPE')
  const paths: string[] = []
  for (const database of databases)
    for (const path of ['', '-wal', '-shm', '-journal'].map((suffix) => database + suffix)) {
      try {
        await lstat(path)
        paths.push(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        if (path === database) throw new ClaudeQuiescenceError('INVALID_SCOPE')
      }
    }
  const result = command('/usr/sbin/lsof', ['-t', '--', ...paths])
  if (result.status === 0 && result.stdout.trim()) throw new ClaudeQuiescenceError('PROCESS_PRESENT')
  if (result.status !== 1 || result.stdout.trim() || result.stderr.trim())
    throw new ClaudeQuiescenceError('PROBE_FAILED')
}

function assertServicesAbsent(services: readonly string[]) {
  for (const service of services) {
    const match = /^gui\/(\d+)\/([A-Za-z0-9.-]+)$/.exec(service)
    if (!match) throw new ClaudeQuiescenceError('INVALID_SCOPE')
    const result = command('/bin/launchctl', ['print', service])
    if (result.status === 0) throw new ClaudeQuiescenceError('SERVICE_REGISTERED')
    const expected = `Could not find service "${match[2]}" in domain for user gui: ${match[1]}`
    if (result.status !== 113 || result.stdout.trim() || !result.stderr.includes(expected))
      throw new ClaudeQuiescenceError('PROBE_FAILED')
  }
}

function assertPortsFree(ports: readonly number[]) {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ClaudeQuiescenceError('INVALID_SCOPE')
    const result = command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
    if (result.status === 0 && result.stdout.trim()) throw new ClaudeQuiescenceError('LISTENER_PRESENT')
    if (result.status !== 1 || result.stdout.trim() || result.stderr.trim())
      throw new ClaudeQuiescenceError('PROBE_FAILED')
  }
}

export async function assertClaudeTransferStopped(scope: ClaudeTransferProcessScope): Promise<void> {
  if (
    !scope.processIDs.length ||
    !scope.ports.length ||
    scope.processIDs.some((pid) => !Number.isInteger(pid) || pid <= 1) ||
    scope.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
  )
    throw new ClaudeQuiescenceError('INVALID_SCOPE')
  assertServicesAbsent(scope.launchdServices)
  for (const pid of scope.processIDs) {
    const result = command('/bin/ps', ['-p', String(pid), '-o', 'pid='])
    if (result.status === 0 && result.stdout.trim()) throw new ClaudeQuiescenceError('PROCESS_PRESENT')
    if (result.status !== 1 || result.stdout.trim() || result.stderr.trim())
      throw new ClaudeQuiescenceError('PROBE_FAILED')
  }
  assertPortsFree(scope.ports)
}
