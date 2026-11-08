import { spawn } from 'node:child_process'
import path from 'node:path'
import { getManagerScriptsPath } from '@opencode-manager/shared/config/env'

export type LearningScriptName = 'search.mjs' | 'record.mjs' | 'lint.mjs'

export interface LearningScriptRequest {
  script: LearningScriptName
  args: readonly string[]
  stdin?: string
  timeoutMs?: number
  bunPath?: string
}

export interface LearningScriptResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type LearningScriptRunner = (request: LearningScriptRequest) => Promise<LearningScriptResult>

export function runLearningScript({
  script,
  args,
  stdin,
  timeoutMs = 15000,
  bunPath,
}: LearningScriptRequest): Promise<LearningScriptResult> {
  const scriptsDir = getManagerScriptsPath()
  const executable = bunPath ?? (process.versions.bun ? process.execPath : 'bun')
  const child = spawn(executable, ['--no-env-file', path.join(scriptsDir, 'learning-review', script), ...args], {
    cwd: scriptsDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.on('error', () => undefined)
  child.stdin.end(stdin ?? '')

  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (exitCode: number | null) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    }
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code))
  })
}
