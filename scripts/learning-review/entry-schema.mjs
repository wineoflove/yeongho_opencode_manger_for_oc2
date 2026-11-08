import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const PATTERN_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/
export const KINDS = new Set(['correction', 'error', 'solution', 'preference'])
export const METADATA_FIELDS = [
  'ID',
  'Pattern-Key',
  'Status',
  'Kind',
  'Observed-At',
  'Source',
  'Conditions',
  'Evidence',
  'Related',
]

export async function readEntryDocuments(directory) {
  const documents = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const handle = await open(
      join(directory, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      if (!(await handle.stat()).isFile()) continue
      const text = (await handle.readFile('utf8')).replace(/\r\n/g, '\n')
      const fields = Object.fromEntries(
        METADATA_FIELDS.map((key) => [key, text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1].trim() ?? '']),
      )
      documents.push({ file: entry.name, name: entry.name.slice(0, -3), text, fields })
    } finally {
      await handle.close()
    }
  }
  return documents
}

export function relatedNames(documents) {
  return new Set(documents.flatMap((document) => [document.name, document.fields.ID]).filter(Boolean))
}
