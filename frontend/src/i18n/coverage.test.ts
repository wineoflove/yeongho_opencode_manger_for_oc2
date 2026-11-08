import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KO, findConflictingKeys } from './ko'
import { ENFORCED_AREAS } from './scan/enforced'
import { describeFinding, isScannable, keyProblems, selectedAreas, targetFiles, unusedKeys } from './scan/gate'
import { collectKeys } from './scan/keys'
import { scanSource } from './scan/scanSource'

const ROOT = join(__dirname, '..', '..')
const TIMEOUT = 60_000

const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .map((entry) => `src/${entry.replaceAll('\\', '/')}`)
  .filter(isScannable)
  .sort()
const sources = new Map(files.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]))
const areas = selectedAreas(process.env.I18N_AREA, ENFORCED_AREAS)
const targets = targetFiles(files, ENFORCED_AREAS, areas)
const keyFiles = areas ? targets : files
const keys = keyFiles.flatMap((file) => collectKeys(file, sources.get(file) ?? ''))

describe('i18n coverage', () => {
  it(
    '(a) enforced files have no untranslated text',
    () => {
      const findings = targets.flatMap((file) => scanSource(file, sources.get(file) ?? '')).map(describeFinding)

      expect(findings, findings.join('\n')).toEqual([])
    },
    TIMEOUT,
  )

  it(
    '(b, c) every used key exists in KO with the same placeholders',
    () => {
      const problems = keyProblems(keys, KO)

      expect(problems, problems.join('\n')).toEqual([])
    },
    TIMEOUT,
  )

  it('(d) catalog files agree on shared keys', () => {
    expect(findConflictingKeys()).toEqual([])
  })

  it.runIf(areas === undefined)(
    '(e) lists unused KO keys',
    () => {
      const unused = unusedKeys(keys, KO)

      if (unused.length > 0) console.warn(`Unused KO keys (${unused.length}):\n${unused.join('\n')}`)
    },
    TIMEOUT,
  )
})
