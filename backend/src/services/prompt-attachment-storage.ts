import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { getReposPath, getWorkspacePath } from '@opencode-manager/shared/config/env'
import {
  PromptAttachmentMetadataSchema,
  type PromptAttachmentMetadata,
  type StoredPromptAttachment,
  type StoredPromptAttachmentList,
} from '@opencode-manager/shared/schemas'

const METADATA_FILE = 'meta.json'
const MAX_METADATA_BYTES = 16 * 1024
const UPLOAD_ID = /^(?:file|zip)-[A-Za-z0-9]{6}$/
const STORED_NAME = /^original\.[a-z0-9]{1,16}$/

async function resolveStorage(create: boolean): Promise<string | undefined> {
  const workspace = await realpath(getWorkspacePath())
  if (create) await mkdir(getReposPath(), { recursive: true })
  const repositories = await realpath(getReposPath()).catch(() => undefined)
  if (!repositories || !repositories.startsWith(`${workspace}${sep}`)) return undefined
  const storage = join(repositories, '.attachments')
  if (create) await mkdir(storage, { recursive: true, mode: 0o700 })
  const resolved = await realpath(storage).catch(() => undefined)
  return resolved === storage ? storage : undefined
}

export async function allocatePromptAttachment(filename: string) {
  const storage = await resolveStorage(true)
  if (!storage) return undefined
  const extension = extname(filename).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '.bin'
  const directory = await mkdtemp(join(storage, safeExtension === '.zip' ? 'zip-' : 'file-'))
  return { directory, path: join(directory, `original${safeExtension}`) }
}

/**
 * Records who uploaded a stored file and where it went. A failure here never fails the upload
 * itself; the uploads screen then falls back to the stored name and file time.
 */
export async function writePromptAttachmentMetadata(directory: string, metadata: PromptAttachmentMetadata) {
  const parsed = PromptAttachmentMetadataSchema.safeParse(metadata)
  if (!parsed.success) return false
  try {
    await writeFile(join(directory, METADATA_FILE), JSON.stringify(parsed.data), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

async function readMetadata(directory: string): Promise<PromptAttachmentMetadata | undefined> {
  const path = join(directory, METADATA_FILE)
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_METADATA_BYTES) return undefined
  try {
    const parsed = PromptAttachmentMetadataSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function readEntry(storage: string, id: string): Promise<StoredPromptAttachment | undefined> {
  if (!UPLOAD_ID.test(id)) return undefined
  const directory = join(storage, id)
  const info = await lstat(directory).catch(() => undefined)
  if (!info?.isDirectory()) return undefined
  const names = await readdir(directory).catch(() => [])
  const storedName = names.find((name) => STORED_NAME.test(name))
  if (!storedName) return undefined
  const path = join(directory, storedName)
  const file = await lstat(path).catch(() => undefined)
  if (!file?.isFile()) return undefined
  const metadata = await readMetadata(directory)
  return {
    id,
    filename: metadata?.filename ?? storedName,
    storedName,
    path,
    size: file.size,
    uploadedAt: Math.round(metadata?.uploadedAt ?? (file.birthtimeMs || file.mtimeMs)),
    directory: metadata?.directory ?? null,
    sessionID: metadata?.sessionID ?? null,
    hasMetadata: metadata !== undefined,
  }
}

/** Lists completed uploads, newest first. Uploads still receiving chunks have no stored file yet. */
export async function listStoredPromptAttachments(): Promise<StoredPromptAttachmentList> {
  const storage = await resolveStorage(false)
  if (!storage) return { entries: [], totalBytes: 0 }
  const ids = (await readdir(storage).catch(() => [])).filter((name) => UPLOAD_ID.test(name))
  const entries = (await Promise.all(ids.map((id) => readEntry(storage, id)))).filter(
    (entry): entry is StoredPromptAttachment => entry !== undefined,
  )
  entries.sort((left, right) => right.uploadedAt - left.uploadedAt || left.id.localeCompare(right.id))
  return { entries, totalBytes: entries.reduce((total, entry) => total + entry.size, 0) }
}

export async function findStoredPromptAttachment(id: string): Promise<StoredPromptAttachment | undefined> {
  const storage = await resolveStorage(false)
  if (!storage) return undefined
  return readEntry(storage, id)
}

/** Deletes one completed upload directory after re-checking that it is a real child of the storage folder. */
export async function deleteStoredPromptAttachment(id: string): Promise<boolean> {
  const storage = await resolveStorage(false)
  if (!storage) return false
  const entry = await readEntry(storage, id)
  if (!entry) return false
  const directory = join(storage, id)
  if ((await realpath(directory)) !== directory || !(await stat(directory)).isDirectory()) return false
  await rm(directory, { recursive: true, force: true })
  return true
}
