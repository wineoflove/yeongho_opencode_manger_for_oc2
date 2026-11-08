import { describe, expect, it } from 'vitest'
import { collectKeys } from './keys'
import { keyProblems, unusedKeys } from './gate'

const expressions = [
  "flag ? 'First' : 'Second'",
  "'First' || 'Second'",
  "'First' ?? 'Second'",
  "'First' && 'Second'",
  "(('First'))",
  "flag ? (value ?? 'First') : (value || ('Second'))",
] as const

describe('expression translation keys', () => {
  it('ignores empty fallbacks while collecting nonempty fallbacks', () => {
    const source = "t(value ?? '')\nt(value ?? 'Fallback')"

    const keys = collectKeys('src/example.ts', source)

    expect(keys).toEqual([{ file: 'src/example.ts', line: 2, key: 'Fallback', parts: ['Fallback'] }])
  })

  for (const expression of expressions) {
    for (const name of ['t', 'tr', 'tn-first', 'tn-second'] as const) {
      const literals = expression.includes('Second') ? ['First', 'Second'] : ['First']
      const expected = literals.map((key) =>
        name === 'tn-first' ? `${key}|Other` : name === 'tn-second' ? `One|${key}` : key,
      )
      const source =
        name === 'tn-first'
          ? `tn(${expression}, 'Other', count)`
          : name === 'tn-second'
            ? `tn('One', ${expression}, count)`
            : `${name}(${expression}, {})`

      it(`counts ${name} keys in ${expression} as used`, () => {
        const catalog = Object.fromEntries(expected.map((key) => [key, key]))

        const keys = collectKeys('src/example.ts', source)

        expect(keys.map((key) => key.key)).toEqual(expected)
        expect(unusedKeys(keys, catalog)).toEqual([])
      })

      it(`reports missing ${name} keys in ${expression}`, () => {
        const keys = collectKeys('src/example.ts', source)

        const problems = keyProblems(keys, {})

        expect(problems).toEqual(expected.map((key) => `src/example.ts:1 missing ${key}`))
      })
    }
  }

  it('combines both conditional plural forms and preserves placeholders', () => {
    const source = "tn(flag ? '{count} day' : '{count} hour', flag ? '{count} days' : '{count} hours', count)"

    const keys = collectKeys('src/example.ts', source)

    expect(keys.map((key) => key.key)).toEqual([
      '{count} day|{count} days',
      '{count} day|{count} hours',
      '{count} hour|{count} days',
      '{count} hour|{count} hours',
    ])
    expect(keyProblems(keys, Object.fromEntries(keys.map((key) => [key.key, '기간'])))).toHaveLength(4)
  })

  it('ignores condition literals, interpolation arguments and unrelated nested calls', () => {
    const source = "t(mode === 'Condition' ? getLabel('Argument') : 'Visible', { value: 'Variable' })"

    const keys = collectKeys('src/example.ts', source)

    expect(keys.map((key) => key.key)).toEqual(['Visible'])
  })

  it('collects aliased calls with nested result expressions', () => {
    const source = "import { t as translate } from '@/i18n/translate'\ntranslate(value ?? (flag ? 'First' : 'Second'))"

    const keys = collectKeys('src/example.ts', source)

    expect(keys.map((key) => key.key)).toEqual(['First', 'Second'])
  })
})
