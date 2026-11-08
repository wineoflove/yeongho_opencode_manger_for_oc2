import { describe, expect, it } from 'vitest'
import { findConflictingKeys } from '../ko'
import { globToRegExp } from './glob'
import { isScannable, keyProblems, selectedAreas, targetFiles, unusedKeys } from './gate'
import { collectKeys } from './keys'

const table = { sessions: ['src/components/session/**'], repos: ['src/components/repo/*.tsx'] }

describe('globToRegExp', () => {
  it.each([
    ['src/i18n/**', 'src/i18n/dynamic/common.ts', true],
    ['src/i18n/**', 'src/i18nx/a.ts', false],
    ['src/**/*.tsx', 'src/App.tsx', true],
    ['src/*.ts', 'src/lib/a.ts', false],
    ['src/a?.ts', 'src/ab.ts', true],
    ['src/{lib,hooks}/*.ts', 'src/hooks/use.ts', true],
    ['src/{lib,hooks}/*.ts', 'src/pages/use.ts', false],
    ['src/a.ts', 'src/aXts', false],
  ])('matches %s against %s as %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected)
  })
})

describe('coverage gate helpers', () => {
  it('excludes tests, test setup, catalogs and the scanner', () => {
    const files = [
      'src/App.tsx',
      'src/App.test.tsx',
      'src/test/setup.ts',
      'src/i18n/ko/common.ts',
      'src/i18n/scan/glob.ts',
      'src/i18n/format.ts',
      'src/a.css',
    ]

    expect(files.filter(isScannable)).toEqual(['src/App.tsx', 'src/i18n/format.ts'])
  })

  it('limits target files to the selected area', () => {
    const files = ['src/components/session/A.tsx', 'src/components/repo/B.tsx', 'src/Other.tsx']

    expect(targetFiles(files, table, selectedAreas('sessions', table))).toEqual(['src/components/session/A.tsx'])
  })

  it('uses every area when none is selected', () => {
    const files = ['src/components/session/A.tsx', 'src/components/repo/B.tsx', 'src/Other.tsx']

    expect(targetFiles(files, table, selectedAreas(undefined, table))).toEqual([
      'src/components/session/A.tsx',
      'src/components/repo/B.tsx',
    ])
  })

  it('accepts a comma separated area list and rejects unknown areas', () => {
    expect(selectedAreas('sessions, repos', table)).toEqual(['sessions', 'repos'])
    expect(() => selectedAreas('nope', table)).toThrow('Unknown I18N_AREA: nope')
  })

  it('reports keys missing from KO including msg and aliased keys', () => {
    const keys = collectKeys(
      'src/a.ts',
      "import { msg as i18nMsg } from '@/i18n/translate'\nt('Known')\ni18nMsg('Missing')\nmsg(`Absent`)",
    )

    expect(keyProblems(keys, { Known: '알려짐' })).toEqual(['src/a.ts:3 missing Missing', 'src/a.ts:4 missing Absent'])
  })

  it('reports placeholder mismatches and joins tn forms', () => {
    const keys = collectKeys(
      'src/a.ts',
      "t('Hi {name}')\ntn('{count} day', '{count} days in {unit}', n)\ntr('Open {link}', {})",
    )

    expect(
      keyProblems(keys, {
        'Hi {name}': '안녕 {user}',
        '{count} day|{count} days in {unit}': '{unit} {count}일',
        'Open {link}': '{link} 열기',
      }),
    ).toEqual(['src/a.ts:1 placeholders Hi {name} expected {name} got {user}'])
  })

  it('lists catalog keys no file uses', () => {
    const keys = collectKeys('src/a.ts', "t('Used')")

    expect(unusedKeys(keys, { Used: '사용', Spare: '여분' })).toEqual(['Spare'])
  })

  it('detects keys with conflicting values across catalog files', () => {
    expect(findConflictingKeys({ a: { Save: '저장' }, b: { Save: '보관' } })).toEqual([
      { key: 'Save', values: { a: '저장', b: '보관' } },
    ])
  })
})
