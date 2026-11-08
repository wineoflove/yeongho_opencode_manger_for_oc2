import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import { Hono } from 'hono'
import { getReposPath, getWorkspacePath } from '@opencode-manager/shared/config/env'
import { createFileRoutes } from '../../src/routes/files'
import type { RegisteredFileRoot } from '../../src/services/file-access'

let root = ''
let external = ''
let outside = ''
let alias = ''
let inside = ''
let other = ''
let shared = ''
let roots: RegisteredFileRoot[] = []
const app = new Hono().route(
  '/api/files',
  createFileRoutes(() => roots),
)
const put = (path: string, content: string) =>
  app.request(`/api/files/ignored?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'file', content }),
  })
const raw = (path: string) => app.request(`/api/files/ignored?path=${encodeURIComponent(path)}&raw=true`)

function zipEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let offset = bytes.indexOf(signature)
  while (offset >= 0) {
    const length = bytes.readUInt16LE(offset + 28)
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8')
    const local = bytes.readUInt32LE(offset + 42)
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20))
    entries.set(name, bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data)
    offset = bytes.indexOf(
      signature,
      offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32),
    )
  }
  return entries
}

beforeEach(async () => {
  await mkdir(getReposPath(), { recursive: true })
  root = await mkdtemp(join(tmpdir(), 'confinement-'))
  external = join(root, 'external')
  outside = join(root, 'outside')
  const prefix = basename(root)
  alias = `${prefix}-alias`
  inside = `${prefix}-inside`
  other = `${prefix}-other`
  shared = `${prefix}-shared.txt`
  for (const directory of [external, outside, join(getReposPath(), inside), join(getReposPath(), other)])
    await mkdir(directory, { recursive: true })
  await symlink(external, join(getReposPath(), alias))
  roots = [{ localPath: alias, sourcePath: external }, { localPath: inside }, { localPath: other }]
  await writeFile(join(external, 'note.txt'), 'external\nsecond\n')
  await writeFile(join(outside, 'sentinel.txt'), 'OUTSIDE')
  await writeFile(join(getReposPath(), inside, 'target.txt'), 'inside')
  await writeFile(join(getReposPath(), other, 'other.txt'), 'OTHER')
  await writeFile(join(getWorkspacePath(), shared), 'SHARED')
  await symlink('target.txt', join(getReposPath(), inside, 'internal-link.txt'))
  await symlink(join(outside, 'sentinel.txt'), join(getReposPath(), inside, 'escape.txt'))
  await symlink(join(getReposPath(), other, 'other.txt'), join(getReposPath(), inside, 'cross-repo.txt'))
  await symlink(outside, join(external, 'escape-dir'))
})
afterEach(async () => {
  await rm(join(getReposPath(), alias), { force: true })
  await rm(join(getReposPath(), inside), { recursive: true, force: true })
  await rm(join(getReposPath(), other), { recursive: true, force: true })
  await rm(join(getWorkspacePath(), shared), { force: true })
  if (root) await rm(root, { recursive: true, force: true })
})

test('retains external alias reads, ranges and nested creation', async () => {
  expect(await (await raw(`${alias}/note.txt`)).text()).toBe('external\nsecond\n')
  const range = await app.request(`/api/files/${alias}/note.txt?startLine=0&endLine=1`)
  expect(await range.json()).toMatchObject({ lines: ['external'] })
  expect((await put(`${alias}/new/folder/note.txt`, 'created')).status).toBe(200)
  expect(await readFile(join(external, 'new/folder/note.txt'), 'utf8')).toBe('created')
})

test('preserves internal symlink content edits and workspace navigation', async () => {
  expect((await put(`${inside}/internal-link.txt`, 'edited')).status).toBe(200)
  expect(await readFile(join(getReposPath(), inside, 'target.txt'), 'utf8')).toBe('edited')
  expect(await readlink(join(getReposPath(), inside, 'internal-link.txt'))).toBe('target.txt')
  expect(await (await raw(`../${shared}`)).text()).toBe('SHARED')
  expect((await app.request('/api/files/')).status).toBe(200)
  expect((await app.request('/api/files/ignored?path=..')).status).toBe(200)
})

test('rejects outside and cross-repo content reads and writes without changing targets', async () => {
  for (const name of ['escape.txt', 'cross-repo.txt']) {
    expect((await raw(`${inside}/${name}`)).status).toBe(403)
    expect((await put(`${inside}/${name}`, 'bad')).status).toBe(403)
  }
  expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE')
  expect(await readFile(join(getReposPath(), other, 'other.txt'), 'utf8')).toBe('OTHER')
  expect((await app.request(`/api/files/${inside}`)).status).toBe(200)
})

test('applies the same confinement to absolute workspace paths', async () => {
  const absolute = (name: string) => join(getReposPath(), inside, name)
  expect(await (await raw(absolute('target.txt'))).text()).toBe('inside')
  expect((await raw(absolute('escape.txt'))).status).toBe(403)
  expect((await put(absolute('escape.txt'), 'bad')).status).toBe(403)
  expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE')
})

test('rejects traversing away from the selected namespace and symlink-parent creation', async () => {
  expect((await raw(`${inside}/../${other}/other.txt`)).status).toBe(403)
  expect((await put(`${alias}/escape-dir/new.txt`, 'bad')).status).toBe(403)
  const form = new FormData()
  form.set('file', new File(['bad'], 'upload.txt', { type: 'text/plain' }))
  form.set('relativePath', `../${other}/upload.txt`)
  expect((await app.request(`/api/files/${inside}`, { method: 'POST', body: form })).status).toBe(403)
})

test('allows moving and deleting a link entry without touching its outside target', async () => {
  const moved = await app.request(`/api/files/${inside}/escape.txt`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPath: `${other}/escape-moved.txt` }),
  })
  expect(moved.status).toBe(200)
  expect(await readlink(join(getReposPath(), other, 'escape-moved.txt'))).toBe(join(outside, 'sentinel.txt'))
  expect((await app.request(`/api/files/${other}/escape-moved.txt`, { method: 'DELETE' })).status).toBe(200)
  expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE')
})

test('allows explicit file moves across repositories', async () => {
  await put(`${inside}/move-me.txt`, 'move-control')
  const response = await app.request(`/api/files/${inside}/move-me.txt`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPath: `${other}/moved.txt` }),
  })
  expect(response.status).toBe(200)
  expect(await readFile(join(getReposPath(), other, 'moved.txt'), 'utf8')).toBe('move-control')
})

test('denies alias replacement but uses current registration snapshot on the next request', async () => {
  roots = roots.map((entry) => (entry.localPath === alias ? { ...entry, sourcePath: outside } : entry))
  expect((await raw(`${alias}/note.txt`)).status).toBe(403)
  roots = roots.map((entry) => (entry.localPath === alias ? { ...entry, sourcePath: external } : entry))
  expect((await raw(`${alias}/note.txt`)).status).toBe(200)
})

test('denies archive and ignored-path traversal outside workspace', async () => {
  expect((await app.request('/api/files/download-zip?path=../../outside')).status).toBe(403)
  expect((await app.request('/api/files/ignored-paths?path=../../outside')).status).toBe(403)
})

test('keeps directory links navigable and isolates dangling or cyclic links from listing', async () => {
  await mkdir(join(getReposPath(), inside, 'folder'))
  await symlink('folder', join(getReposPath(), inside, 'folder-link'))
  await symlink('missing', join(getReposPath(), inside, 'dangling'))
  await symlink('cycle', join(getReposPath(), inside, 'cycle'))
  const listing = await app.request(`/api/files/${inside}`)
  expect(listing.status).toBe(200)
  expect(await listing.json()).toMatchObject({
    children: expect.arrayContaining([
      {
        name: 'folder-link',
        path: `${inside}/folder-link`,
        isDirectory: true,
        size: 0,
        lastModified: expect.any(String),
      },
    ]),
  })
  expect((await put(`${inside}/dangling`, 'bad')).status).toBe(403)
  expect((await raw(`${inside}/cycle`)).status).toBe(403)
  expect((await app.request(`/api/files/${inside}/dangling`, { method: 'DELETE' })).status).toBe(200)
})

test('allows a nested registered external alias and preserves root-specific isolation', async () => {
  await symlink(external, join(getReposPath(), inside, 'registered-child'))
  roots.push({ localPath: `${inside}/registered-child`, sourcePath: external })
  expect(await (await raw(`${inside}/registered-child/note.txt`)).text()).toBe('external\nsecond\n')
  expect((await raw(`${inside}/registered-child/../target.txt`)).status).toBe(403)
})

test('archives readable external alias files without including escaping links', async () => {
  const response = await app.request(`/api/files/${alias}/download-zip`)
  expect(response.status).toBe(200)
  const entries = zipEntries(Buffer.from(await response.arrayBuffer()))
  expect([...entries.keys()].some((name) => name.endsWith('/note.txt'))).toBe(true)
  expect([...entries.keys()].some((name) => name.includes('escape-dir'))).toBe(false)
  expect([...entries.values()].some((bytes) => bytes.toString() === 'OUTSIDE')).toBe(false)
  expect([...entries.values()].some((bytes) => bytes.toString() === 'external\nsecond\n')).toBe(true)
})

test('uses the nested registered root for uploads initiated from its parent', async () => {
  await mkdir(join(getReposPath(), inside, 'child'))
  await mkdir(join(getReposPath(), inside, 'sub'))
  await symlink('../target.txt', join(getReposPath(), inside, 'child', 'escape.txt'))
  roots.push({ localPath: `${inside}/child` })
  const form = new FormData()
  form.set('file', new File(['bad'], 'escape.txt', { type: 'text/plain' }))
  form.set('relativePath', 'child/escape.txt')
  expect((await app.request(`/api/files/${inside}`, { method: 'POST', body: form })).status).toBe(403)
  expect(await readFile(join(getReposPath(), inside, 'target.txt'), 'utf8')).toBe('inside')
  const traversal = new FormData()
  traversal.set('file', new File(['bad'], 'target.txt', { type: 'text/plain' }))
  traversal.set('relativePath', 'child/../target.txt')
  expect((await app.request(`/api/files/${inside}`, { method: 'POST', body: traversal })).status).toBe(403)
  expect(await readFile(join(getReposPath(), inside, 'target.txt'), 'utf8')).toBe('inside')
  expect((await raw(`${inside}/sub/../child/../target.txt`)).status).toBe(403)
  const absoluteTraversal = `${getReposPath()}/${inside}/sub/../child/../target.txt`
  expect((await app.request(`/api/files/download-zip?path=${encodeURIComponent(absoluteTraversal)}`)).status).toBe(403)
})

test('allows parent-initiated uploads into an explicitly registered nested external alias', async () => {
  await symlink(external, join(getReposPath(), inside, 'registered-child'))
  roots.push({ localPath: `${inside}/registered-child`, sourcePath: external })
  const form = new FormData()
  form.set('file', new File(['nested-upload'], 'upload.txt', { type: 'text/plain' }))
  form.set('relativePath', 'registered-child/upload.txt')
  expect((await app.request(`/api/files/${inside}`, { method: 'POST', body: form })).status).toBe(200)
  expect(await readFile(join(external, 'upload.txt'), 'utf8')).toBe('nested-upload')
})

test('permits entry deletion of an approved root beneath an otherwise unregistered parent link', async () => {
  await mkdir(join(outside, 'approved-child'))
  await writeFile(join(outside, 'approved-child', 'file.txt'), 'approved')
  await symlink(outside, join(getReposPath(), inside, 'bridge'))
  roots.push({ localPath: `${inside}/bridge/approved-child`, sourcePath: join(outside, 'approved-child') })
  expect(await (await raw(`${inside}/bridge/approved-child/file.txt`)).text()).toBe('approved')
  expect((await app.request(`/api/files/${inside}/bridge/approved-child`, { method: 'DELETE' })).status).toBe(200)
  expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE')
})

test('retains absolute registered directory ZIP and ignored-path requests', async () => {
  const response = await app.request(`/api/files/download-zip?path=${encodeURIComponent(external)}`)
  expect(response.status).toBe(200)
  expect(
    [...zipEntries(Buffer.from(await response.arrayBuffer())).values()].some(
      (bytes) => bytes.toString() === 'external\nsecond\n',
    ),
  ).toBe(true)
  expect((await app.request(`/api/files/ignored-paths?path=${encodeURIComponent(external)}`)).status).toBe(200)
  expect((await app.request(`/api/files/download-zip?path=${encodeURIComponent(outside)}`)).status).toBe(403)
})
