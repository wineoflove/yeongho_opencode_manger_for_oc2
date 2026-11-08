import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type RegisteredFileRoot = { readonly localPath: string; readonly sourcePath?: string }
export type FileAccessOptions = { readonly entryOnly?: boolean; readonly scopePath?: string }
export type FileAccessPolicy = {
  readonly reposPath: string
  resolve(userPath: string, options?: FileAccessOptions): Promise<string>
  resolveArchive(userPath: string): Promise<string>
  canRead(userPath: string, options?: FileAccessOptions): Promise<boolean>
  archiveFilter(userPath: string): Promise<(target: string) => Promise<boolean>>
}

export class FileAccessDenied extends Error {
  readonly statusCode = 403
  constructor() {
    super('Path is outside the allowed file root')
  }
}

function within(root: string, target: string): boolean {
  const part = relative(root, target)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function inaccessible(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && ['ELOOP', 'EACCES', 'EPERM', 'ENOTDIR'].includes(String(error.code))
  )
}

async function canonicalWithMissingLeaf(target: string): Promise<string> {
  let current = target
  const suffix: string[] = []
  for (;;) {
    try {
      const entry = await lstat(current)
      try {
        return resolve(await realpath(current), ...suffix)
      } catch (error) {
        if (entry.isSymbolicLink()) throw new FileAccessDenied()
        throw error
      }
    } catch (error) {
      if (inaccessible(error)) throw new FileAccessDenied()
      if (!missing(error) || dirname(current) === current) throw error
      suffix.unshift(basename(current))
      current = dirname(current)
    }
  }
}

export function createFileAccessPolicy(input: {
  readonly workspacePath: string
  readonly reposPath: string
  readonly roots: readonly RegisteredFileRoot[]
}): FileAccessPolicy {
  const workspace = resolve(input.workspacePath)
  const repos = resolve(input.reposPath)
  const roots = input.roots.map((root) => ({ ...root, alias: resolve(repos, root.localPath) }))
  if (!within(workspace, repos) || roots.some((root) => !within(repos, root.alias) || root.alias === repos)) {
    throw new FileAccessDenied()
  }
  roots.sort((left, right) => right.alias.length - left.alias.length)

  function scopeFor(target: string) {
    const registered = roots.find((root) => within(root.alias, target))
    if (registered) return registered
    if (!within(repos, target) || target === repos) return undefined
    const first = relative(repos, target).split(sep)[0]
    return first ? { alias: join(repos, first), sourcePath: undefined } : undefined
  }

  function archiveUserPath(userPath: string): string {
    if (!isAbsolute(userPath)) return userPath
    const hasPrefix = (base: string) =>
      userPath === base || userPath.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
    const suffix = (base: string) =>
      userPath === base ? '' : userPath.slice(base.endsWith(sep) ? base.length : base.length + 1)
    if (hasPrefix(repos)) return suffix(repos) || '.'
    if (hasPrefix(workspace)) return `${relative(repos, workspace)}${sep}${suffix(workspace)}`
    const registered = roots
      .filter((root) => root.sourcePath && hasPrefix(resolve(root.sourcePath)))
      .sort((left, right) => (right.sourcePath?.length ?? 0) - (left.sourcePath?.length ?? 0))[0]
    if (!registered?.sourcePath) throw new FileAccessDenied()
    return `${registered.localPath}${sep}${suffix(resolve(registered.sourcePath))}`
  }

  /** Maps an absolute path inside the workspace to the repos-relative form the file service resolves it to. */
  function serviceRelative(input: string): string {
    const userPath = input.trim()
    if (!isAbsolute(userPath)) return userPath
    const absolute = resolve(userPath)
    return within(workspace, absolute) ? relative(repos, absolute) : userPath
  }

  function assertTraversal(userPath: string): void {
    let current = repos
    let active = scopeFor(current)
    for (const part of userPath.trim().split(sep)) {
      if (!part || part === '.') continue
      const next = part === '..' ? dirname(current) : join(current, part)
      if (active && !within(active.alias, next)) throw new FileAccessDenied()
      current = next
      active = scopeFor(current)
    }
  }

  const policy: FileAccessPolicy = {
    reposPath: repos,
    async resolve(requestedPath, options = {}) {
      const userPath = serviceRelative(requestedPath)
      const scopePath = options.scopePath === undefined ? undefined : serviceRelative(options.scopePath)
      const target = resolve(join(repos, userPath || '.'))
      if (!within(workspace, target)) throw new FileAccessDenied()
      assertTraversal(userPath)
      if (scopePath !== undefined) assertTraversal(scopePath)
      const scoped = scopePath === undefined ? undefined : scopeFor(resolve(join(repos, scopePath)))
      if (scoped && !within(scoped.alias, target)) throw new FileAccessDenied()
      const scope = scopeFor(target)
      if (scope && !within(scope.alias, target)) throw new FileAccessDenied()
      if (options.entryOnly && scope?.alias === target) {
        if (scope.sourcePath) {
          if ((await canonicalWithMissingLeaf(scope.alias)) !== (await realpath(scope.sourcePath)))
            throw new FileAccessDenied()
          return target
        }
        await policy.resolve(relative(repos, dirname(target)))
        return target
      }
      const canonicalWorkspace = await realpath(workspace)
      let allowed = canonicalWorkspace
      if (scope) {
        const actualRoot = await canonicalWithMissingLeaf(scope.alias)
        const expectedRoot = scope.sourcePath
          ? await realpath(scope.sourcePath)
          : resolve(await realpath(repos), relative(repos, scope.alias))
        if (actualRoot !== expectedRoot) throw new FileAccessDenied()
        allowed = expectedRoot
      }
      const inspected = options.entryOnly ? dirname(target) : target
      const actual = await canonicalWithMissingLeaf(inspected)
      if (!within(allowed, actual)) throw new FileAccessDenied()
      return target
    },
    async resolveArchive(userPath) {
      return policy.resolve(archiveUserPath(userPath))
    },
    async canRead(userPath, options) {
      try {
        await policy.resolve(userPath, options)
        return true
      } catch (error) {
        if (error instanceof FileAccessDenied || missing(error)) return false
        throw error
      }
    },
    async archiveFilter(userPath) {
      const scopedPath = archiveUserPath(userPath)
      const base = await realpath(await policy.resolve(scopedPath))
      return async (target) => policy.canRead(join(scopedPath, relative(base, target)), { scopePath: scopedPath })
    },
  }
  return policy
}
