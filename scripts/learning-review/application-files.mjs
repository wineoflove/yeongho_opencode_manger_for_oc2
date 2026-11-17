import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from '../../shared/src/zod.ts'

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')
export const absolutePath = z.string().refine(isAbsolute)
export const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const Config = z
  .object({
    version: z.literal(1),
    store: absolutePath,
    codeRoots: z.array(absolutePath).min(1),
    policies: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            path: absolutePath,
            mutable: z.boolean(),
            protectedHeadings: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .min(1),
    aliases: z.record(z.string(), z.string()).default({}),
    runtime: z.object({ directory: absolutePath, sessionDb: absolutePath }).strict().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const field of ['id', 'path']) {
      if (new Set(config.policies.map((policy) => policy[field])).size !== config.policies.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate policy ${field}` })
    }
    for (const [key, target] of Object.entries(config.aliases)) {
      if (key === target || config.aliases[target]) ctx.addIssue({ code: 'custom', message: 'Alias chains forbidden' })
    }
  })

export function inside(root, path) {
  const name = relative(resolve(root), resolve(path))
  return name !== '..' && !name.startsWith('../') && !isAbsolute(name)
}

export async function readBounded(path, maxBytes = 256 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('UNSAFE_OR_OVERSIZED_FILE')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await file.stat()
    if (length > maxBytes || length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('FILE_CHANGED_DURING_READ')
    return buffer.toString('utf8', 0, length)
  } finally {
    await file.close()
  }
}

export async function loadConfig(path) {
  return Config.parse(JSON.parse(await readBounded(path)))
}

export async function targetPath(config, path) {
  if (!isAbsolute(path)) throw new Error('ABSOLUTE_TARGET_REQUIRED')
  const canonical = await realpath(path)
  const policy = config.policies.find((item) => resolve(item.path) === resolve(path))
  if (policy) return { path: resolve(path), policy }
  const forbidden =
    /(?:^|\/)(?:\.env[^/]*|\.git|\.config|\.opencode|\.venv|__pycache__|node_modules|dist|coverage|auth\.json)(?:\/|$)/
  if (!/\.(?:[cm]?[jt]sx?|py|md|jsonc?|toml|ya?ml)$/.test(path)) throw new Error('TARGET_NOT_ALLOWED')
  for (const root of config.codeRoots) {
    const canonicalRoot = await realpath(root)
    if (
      inside(root, path) &&
      inside(canonicalRoot, canonical) &&
      !forbidden.test(relative(root, path)) &&
      !forbidden.test(relative(canonicalRoot, canonical))
    )
      return { path: resolve(path), policy: null }
  }
  throw new Error('TARGET_NOT_ALLOWED')
}

export async function artifactPath(config, name) {
  if (isAbsolute(name) || !/^(?:applications|reviews)\//.test(name)) throw new Error('INVALID_ARTIFACT_PATH')
  const path = resolve(config.store, name)
  if (!inside(config.store, path) || !inside(await realpath(config.store), await realpath(path)))
    throw new Error('ARTIFACT_OUTSIDE_STORE')
  return path
}

export async function readArtifact(config, name) {
  return readBounded(await artifactPath(config, name), 4 * 1024 * 1024)
}

export async function saveArtifact(config, folder, value) {
  const directory = resolve(config.store, 'applications', folder)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!inside(await realpath(config.store), await realpath(directory))) throw new Error('ARTIFACT_OUTSIDE_STORE')
  const name = `applications/${folder}/${Date.now()}-${randomUUID()}.json`
  const file = await open(resolve(config.store, name), 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  return name
}

export async function snapshotTarget(config, path) {
  const target = await targetPath(config, path)
  const text = await readBounded(target.path)
  const snapshot = {
    version: 1,
    path: target.path,
    sha256: sha256(text),
    text,
  }
  const artifact = await saveArtifact(config, 'snapshots', snapshot)
  return { path: target.path, sha256: snapshot.sha256, snapshot: artifact }
}
