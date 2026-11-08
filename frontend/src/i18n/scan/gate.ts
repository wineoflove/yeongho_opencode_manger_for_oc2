import { globToRegExp } from './glob'
import type { UsedKey } from './keys'
import type { Finding } from './scanSource'

export type AreaTable = Readonly<Record<string, readonly string[]>>

const EXCLUDED = [/\.test\.[^/]+$/, /^src\/test\//, /^src\/i18n\/ko\//, /^src\/i18n\/scan\//]
const PLACEHOLDER = /\{(\w+)\}/g

export function isScannable(file: string): boolean {
  return /^src\/.*\.tsx?$/.test(file) && !EXCLUDED.some((pattern) => pattern.test(file))
}

export function selectedAreas(value: string | undefined, table: AreaTable): readonly string[] | undefined {
  if (!value?.trim()) return undefined
  const areas = value
    .split(',')
    .map((area) => area.trim())
    .filter((area) => area !== '')
  const unknown = areas.filter((area) => !Object.hasOwn(table, area))
  if (unknown.length > 0) throw new Error(`Unknown I18N_AREA: ${unknown.join(', ')}`)
  return areas
}

export function targetFiles(
  files: readonly string[],
  table: AreaTable,
  areas: readonly string[] | undefined,
): string[] {
  const globs = (areas ?? Object.keys(table)).flatMap((area) => table[area] ?? [])
  const patterns = globs.map(globToRegExp)
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)))
}

function placeholderSet(texts: readonly string[]): string {
  return [...new Set(texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1])))]
    .sort()
    .join(',')
}

export function keyProblems(keys: readonly UsedKey[], catalog: Readonly<Record<string, string>>): string[] {
  return keys.flatMap(({ file, line, key, parts }) => {
    const value = catalog[key]
    if (value === undefined) return [`${file}:${line} missing ${key}`]
    const expected = placeholderSet(parts)
    const actual = placeholderSet([value])
    return expected === actual ? [] : [`${file}:${line} placeholders ${key} expected {${expected}} got {${actual}}`]
  })
}

export function unusedKeys(keys: readonly UsedKey[], catalog: Readonly<Record<string, string>>): string[] {
  const used = new Set(keys.map(({ key }) => key))
  return Object.keys(catalog).filter((key) => !used.has(key))
}

export function describeFinding({ file, line, kind, text }: Finding): string {
  return `${file}:${line} ${kind} ${text}`
}
