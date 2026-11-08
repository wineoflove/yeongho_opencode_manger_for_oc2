import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { getReposPath, getWorkspacePath } from '@opencode-manager/shared/config/env'

export async function allocatePromptAttachment(filename: string) {
  const workspace = await realpath(getWorkspacePath())
  await mkdir(getReposPath(), { recursive: true })
  const repositories = await realpath(getReposPath())
  if (!repositories.startsWith(`${workspace}${sep}`)) return undefined
  const storage = join(repositories, '.attachments')
  await mkdir(storage, { recursive: true, mode: 0o700 })
  if ((await realpath(storage)) !== storage) return undefined
  const extension = extname(filename).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '.bin'
  const directory = await mkdtemp(join(storage, safeExtension === '.zip' ? 'zip-' : 'file-'))
  return { directory, path: join(directory, `original${safeExtension}`) }
}
