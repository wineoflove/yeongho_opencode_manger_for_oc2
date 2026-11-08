/** Draft that starts a new session by naming the session it continues from; it is placed in the composer, never sent. */
export function buildReferencePrompt(session: { readonly id: string; readonly title?: string | null }): string {
  return `Reference session: ${session.id} (${session.title?.trim() || 'Untitled session'})\n\n`
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Human-readable working directory of a session relative to its repository root. */
export function describeWorkingDirectory(directory: string | undefined, repoPath: string | undefined): string {
  if (!directory) return 'unknown directory'
  const current = trimTrailingSlash(directory)
  const root = repoPath ? trimTrailingSlash(repoPath) : undefined
  if (!root || current === root) return 'repository root'
  if (current.startsWith(`${root}/`)) return current.slice(root.length + 1)
  return current.split('/').filter(Boolean).at(-1) ?? current
}
