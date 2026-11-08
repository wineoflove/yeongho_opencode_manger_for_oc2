import { describe, it, expect, afterEach } from 'vitest'
import { setLocale } from './locale'
import { msg, t, tn } from './translate'
import { formatNumber } from './format'
import { KO } from './ko'

const PLURAL_KEY = '{count} file|{count} files'
const VAR_KEY = 'Hello {name}'

describe('t', () => {
  afterEach(() => {
    delete KO[PLURAL_KEY]
    delete KO[VAR_KEY]
  })

  it('returns the source text in en', () => {
    expect(t('Save')).toBe('Save')
  })

  it('translates in ko', () => {
    setLocale('ko')

    expect(t('Save')).toBe('저장')
    expect(t('Request failed')).toBe('요청에 실패했습니다')
  })

  it('returns unknown keys unchanged in ko', () => {
    setLocale('ko')

    expect(t('Some server message')).toBe('Some server message')
  })

  it('substitutes variables with String(value)', () => {
    expect(t('{n} tokens', { n: 1234 })).toBe('1234 tokens')
    expect(t('{n} tokens', { n: formatNumber(1234) })).toBe('1,234 tokens')
  })

  it('keeps placeholders missing from vars', () => {
    expect(t('{a} and {b}', { a: 'x' })).toBe('x and {b}')
    expect(t('{a} only')).toBe('{a} only')
  })

  it('substitutes variables into the ko template', () => {
    KO[VAR_KEY] = '{name}님 안녕하세요'
    setLocale('ko')

    expect(t(VAR_KEY, { name: '영호' })).toBe('영호님 안녕하세요')
  })
})

describe('tn', () => {
  afterEach(() => {
    delete KO[PLURAL_KEY]
  })

  it('picks the english plural form', () => {
    expect(tn('{count} file', '{count} files', 1)).toBe('1 file')
    expect(tn('{count} file', '{count} files', 0)).toBe('0 files')
    expect(tn('{count} file', '{count} files', 2)).toBe('2 files')
  })

  it('uses provided count var over the raw count', () => {
    expect(tn('{count} file', '{count} files', 1200, { count: '1,200' })).toBe('1,200 files')
  })

  it('uses the ko one|other key', () => {
    KO[PLURAL_KEY] = '파일 {count}개'
    setLocale('ko')

    expect(tn('{count} file', '{count} files', 1)).toBe('파일 1개')
    expect(tn('{count} file', '{count} files', 3)).toBe('파일 3개')
  })

  it('falls back to other in ko when the key is missing', () => {
    setLocale('ko')

    expect(tn('{count} item', '{count} items', 1)).toBe('1 items')
  })
})

describe('msg', () => {
  it('returns the key unchanged', () => {
    expect(msg('Cancelled')).toBe('Cancelled')
    setLocale('ko')
    expect(msg('Cancelled')).toBe('Cancelled')
  })
})
