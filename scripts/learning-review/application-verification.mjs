import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolveVerificationCommand } from './verification-command.mjs'
import { z } from '../../shared/src/zod.ts'
import {
  absolutePath,
  inside,
  readArtifact,
  readBounded,
  saveArtifact,
  sha256,
  targetPath,
} from './application-files.mjs'
import { sanitize } from './search-entries.mjs'

export const VerificationReceipt = z
  .object({
    version: z.literal(1),
    origin: z.enum(['command', 'file-readback', 'runtime-probe']),
    kind: z.enum(['test', 'typecheck', 'lint', 'build', 'readback', 'runtime']),
    approvalEvidence: z.string().optional(),
    command: z.string(),
    cwd: absolutePath,
    scope: z.string().min(1),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    outputTruncated: z.boolean(),
    output: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    targets: z.array(z.object({ path: absolutePath, sha256: z.string() })),
  })
  .strict()

export async function verifyReadback(config, path, scope) {
  const target = await targetPath(config, path)
  const text = await readBounded(target.path)
  const receipt = {
    version: 1,
    origin: 'file-readback',
    kind: 'readback',
    command: `readback ${target.path}`,
    cwd: config.codeRoots[0],
    scope,
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    output: '파일 전체 읽기와 SHA-256 확인. 의미·실행·운영 성공 검증은 아님.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    targets: [{ path: target.path, sha256: sha256(text) }],
  }
  return {
    ...receipt,
    evidence: await saveArtifact(config, 'checks', VerificationReceipt.parse(receipt)),
  }
}

export async function verifyCommand(config, value) {
  const input = z
    .object({
      argv: z.array(z.string().min(1)).min(2).max(100),
      cwd: absolutePath,
      scope: z.string().min(1).max(2000),
      kind: z.enum(['test', 'typecheck', 'lint', 'build', 'runtime']),
      approvalEvidence: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(300000).default(120000),
      targets: z.array(absolutePath).min(1).max(30),
    })
    .strict()
    .parse(value)
  const cwd = await realpath(input.cwd)
  if (input.kind === 'runtime') {
    if (!input.approvalEvidence) throw new Error('RUNTIME_APPROVAL_REQUIRED')
    await readArtifact(config, input.approvalEvidence)
  }
  const roots = await Promise.all(config.codeRoots.map((root) => realpath(root)))
  if (!roots.some((root) => inside(root, cwd))) throw new Error('CHECK_CWD_NOT_ALLOWED')
  const executable = await resolveVerificationCommand(config, input, cwd)
  const targets = await Promise.all(
    input.targets.map(async (path) => {
      await targetPath(config, path)
      return { path, sha256: sha256(await readBounded(path)) }
    }),
  )
  const startedAt = new Date().toISOString()
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, input.argv.slice(1), {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: '/Users/yeonghokim/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      },
    })
    let output = ''
    let outputTruncated = false
    let timedOut = false
    let forceTimer
    const append = (data) => {
      output += data.toString()
      if (output.length > 128000) {
        output = output.slice(0, 128000)
        outputTruncated = true
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
    }, input.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      reject(error)
    })
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolve({ output, outputTruncated, timedOut, exitCode })
    })
  })
  for (const target of targets) {
    if (sha256(await readBounded(target.path)) !== target.sha256) throw new Error('CHECK_TARGET_CHANGED')
  }
  const receipt = VerificationReceipt.parse({
    version: 1,
    origin: 'command',
    kind: input.kind,
    command: JSON.stringify(input.argv),
    cwd: input.cwd,
    scope: input.scope,
    startedAt,
    finishedAt: new Date().toISOString(),
    targets,
    ...(input.approvalEvidence ? { approvalEvidence: input.approvalEvidence } : {}),
    ...result,
    output: sanitize(result.output),
  })
  return {
    ...receipt,
    evidence: await saveArtifact(config, 'checks', receipt),
  }
}
