import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ClaudeProxyClient, ClaudeProxyError } from './claude-proxy-client'

export class ClaudeProxyConfigError extends Error {
  constructor(readonly code: 'INVALID_CONFIGURATION' | 'KEY_FILE_REJECTED') {
    super(code)
    this.name = 'ClaudeProxyConfigError'
  }
}

export async function loadClaudeProxyClient(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ClaudeProxyClient | undefined> {
  const baseUrl = environment.OCM_CLAUDE_PROXY_URL
  const keyFile = environment.OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE
  if (baseUrl === undefined && keyFile === undefined) return undefined
  if (!baseUrl || !keyFile || !isAbsolute(keyFile)) throw new ClaudeProxyConfigError('INVALID_CONFIGURATION')
  const managementKey = await readPrivateProxyKey(keyFile)
  try {
    return new ClaudeProxyClient({ baseUrl, managementKey })
  } catch (error) {
    if (error instanceof ClaudeProxyError || error instanceof TypeError)
      throw new ClaudeProxyConfigError('INVALID_CONFIGURATION')
    throw error
  }
}

export async function readPrivateProxyKey(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ClaudeProxyConfigError('INVALID_CONFIGURATION')
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const metadata = await handle.stat()
      if (
        !metadata.isFile() ||
        metadata.uid !== process.getuid?.() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > 4096
      )
        throw new ClaudeProxyConfigError('KEY_FILE_REJECTED')
      const value = (await handle.readFile('utf8')).trim()
      if (!/^[\x21-\x7e]{16,4096}$/.test(value)) throw new ClaudeProxyConfigError('KEY_FILE_REJECTED')
      return value
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Error) throw new ClaudeProxyConfigError('KEY_FILE_REJECTED')
    throw error
  }
}
