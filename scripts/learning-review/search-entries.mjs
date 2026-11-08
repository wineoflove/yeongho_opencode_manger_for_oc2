import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from './redact.mjs'

const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const METADATA = /^(ID|Pattern-Key|Status|Kind|Observed-At|Source|Conditions|Evidence|Related):\s*(.*)$/
const STATUSES = new Set(['verified', 'pending', 'superseded'])

export function sanitize(text) {
  return text
    .replace(
      /<private\b[^>]*>[\s\S]*?(?:<\/private\s*>|$)/gi,
      (match) => `[REDACTED PRIVATE]${'\n'.repeat((match.match(/\n/g) ?? []).length)}`,
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      (match) => `[REDACTED KEY]${'\n'.repeat((match.match(/\n/g) ?? []).length)}`,
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .split('\n')
    .map(redact)
    .join('\n')
}

export function parseEntry(text, path) {
  const normalized = text.replace(/\r\n/g, '\n')
  const cleaned = sanitize(normalized)
  const lines = cleaned.split('\n')
  const first = lines.findIndex((line) => line.trim())
  if (first < 0 || !/^#\s+\S/.test(lines[first])) return null
  const fields = new Map()
  let bodyStart = first + 1
  for (; bodyStart < lines.length; bodyStart++) {
    const line = lines[bodyStart]
    if (!line.trim()) {
      if (fields.size) break
      continue
    }
    const match = METADATA.exec(line)
    if (!match || fields.has(match[1])) return null
    fields.set(match[1], { text: match[2].trim(), line: bodyStart + 1 })
  }
  const value = (key) => fields.get(key)?.text ?? ''
  if (!['ID', 'Pattern-Key', 'Status', 'Conditions', 'Evidence', 'Source'].every((key) => value(key))) return null
  if (!STATUSES.has(value('Status'))) return null
  const sections = new Map()
  let section
  let fence
  for (let index = bodyStart; index < lines.length; index++) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index])
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim())
        fence = undefined
      if (section) {
        section.lines.push(lines[index])
        section.endLine = index + 1
      }
      continue
    }
    const heading = fence ? null : /^##\s+(.+?)\s*$/.exec(lines[index])
    if (heading) {
      section = { heading: heading[1].toLowerCase(), line: index + 2, endLine: index + 1, lines: [] }
      if (sections.has(section.heading)) return null
      sections.set(section.heading, section)
    } else if (section) {
      section.lines.push(lines[index])
      section.endLine = index + 1
    }
  }
  const lessons = ['lesson', '교정', '교훈', '선호', '학습', '해결'].map((key) => sections.get(key)).filter(Boolean)
  const limitations = ['limits', '한계', '제한', '검증 범위', '범위와 적용 상태']
    .map((key) => sections.get(key))
    .filter(Boolean)
  if (lessons.length > 1 || limitations.length > 1) return null
  const [lesson] = lessons
  const [limits] = limitations
  if (!lesson?.lines.join('\n').trim()) return null
  return {
    id: value('ID'),
    patternKey: value('Pattern-Key'),
    status: value('Status'),
    kind: value('Kind'),
    observedAt: value('Observed-At'),
    title: lines[first].replace(/^#\s+/, ''),
    conditions: value('Conditions'),
    evidence: value('Evidence'),
    provenance: value('Source'),
    related: value('Related'),
    lesson: lesson.lines.join('\n').trim(),
    limits: limits?.lines.join('\n').trim() ?? '',
    redacted: cleaned !== normalized,
    source: {
      path,
      startLine: first + 1,
      endLine: lines.length,
      evidenceLine: fields.get('Evidence').line,
      lessonStartLine: lesson.line,
      lessonEndLine: lesson.endLine,
    },
  }
}

export async function loadEntries(directory) {
  const root = await realpath(directory)
  const names = []
  let visited = 0
  for await (const entry of await opendir(root)) {
    if (++visited > 5000) throw new Error('LEARNING_SEARCH_TOO_MANY_FILES')
    if (entry.name.endsWith('.md')) names.push(entry)
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const entries = []
  const skipped = { unsafe: 0, oversized: 0, changed: 0, invalid: 0 }
  let bytes = 0
  for (const name of names) {
    if (!name.isFile()) {
      skipped.unsafe++
      continue
    }
    const path = join(root, name.name)
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1) {
        skipped.unsafe++
        continue
      }
      if (before.size > MAX_FILE_BYTES) {
        skipped.oversized++
        continue
      }
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(
          buffer,
          length,
          Math.min(buffer.length - length, MAX_TOTAL_BYTES - bytes + 1),
          length,
        )
        if (!result.bytesRead) break
        length += result.bytesRead
        bytes += result.bytesRead
        if (bytes > MAX_TOTAL_BYTES) throw new Error('LEARNING_SEARCH_INPUT_TOO_LARGE')
      }
      if (length > MAX_FILE_BYTES) {
        skipped.oversized++
        continue
      }
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) {
        skipped.changed++
        continue
      }
      const entry = parseEntry(buffer.toString('utf8', 0, length), path)
      if (entry) entries.push(entry)
      else skipped.invalid++
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error?.code)) skipped.changed++
      else throw error
    } finally {
      await handle?.close()
    }
  }
  return { root, scanned: names.length, entries, skipped }
}
