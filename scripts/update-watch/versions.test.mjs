import { expect, it } from 'bun:test'
import {
  bumpKind,
  compareVersions,
  newerVersions,
  normalize,
  previousInLine,
  selectNoteVersions,
  truncate,
} from './versions.mjs'

it('accepts only stable X.Y.Z versions with an optional v prefix', () => {
  expect(normalize('v1.18.34')).toBe('1.18.34')
  expect(normalize('5.0.0-beta.3')).toBeNull()
  expect(normalize(undefined)).toBeNull()
  expect(compareVersions('1.18.10', '1.18.9')).toBeGreaterThan(0)
})

it('classifies the bump from the installed version', () => {
  expect(bumpKind('1.18.33', '2.0.22')).toBe('major')
  expect(bumpKind('0.18.0', '0.20.0')).toBe('minor')
  expect(bumpKind('1.18.33', '1.18.34')).toBe('patch')
  expect(bumpKind('1.18.34', '1.18.34')).toBe('none')
})

it('lists unique newer stable versions in ascending order', () => {
  expect(newerVersions(['v2.0.1', '1.18.33', 'v1.18.34', '2.0.1', 'v2.0.0', '2.1.0-beta.1'], '1.18.33')).toEqual([
    '1.18.34',
    '2.0.0',
    '2.0.1',
  ])
})

it('finds the previous release only within the same minor line', () => {
  const all = ['1.18.33', '1.18.34', '2.0.0', '2.0.1', '2.0.3']
  expect(previousInLine('2.0.3', all)).toBe('2.0.1')
  expect(previousInLine('2.0.0', all)).toBeNull()
})

it('keeps line starts and the most recent releases of every major line', () => {
  const all = ['1.18.0', '1.18.33', '1.18.34', ...Array.from({ length: 10 }, (_, patch) => `2.0.${patch}`)]
  const fresh = newerVersions(all, '1.18.33')
  expect(selectNoteVersions(fresh, all, 3)).toEqual(['1.18.34', '2.0.0', '2.0.7', '2.0.8', '2.0.9'])
})

it('truncates long release notes with a pointer to the source', () => {
  expect(truncate('abc', 5)).toBe('abc')
  expect(truncate('abcdef', 3).startsWith('abc\n…')).toBe(true)
})
