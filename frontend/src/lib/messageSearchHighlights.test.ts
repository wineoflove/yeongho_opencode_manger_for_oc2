import { describe, expect, it } from 'vitest'
import { splitMessageSnippet } from './messageSearchHighlights'

describe('splitMessageSnippet', () => {
  it('splits UTF-16 offsets without losing surrogate pairs', () => {
    expect(splitMessageSnippet('a😀match!', [{ start: 3, end: 8 }])).toEqual([
      { text: 'a😀', highlighted: false },
      { text: 'match', highlighted: true },
      { text: '!', highlighted: false },
    ])
    expect(splitMessageSnippet('a😀b', [{ start: 2, end: 3 }])).toEqual([
      { text: 'a', highlighted: false },
      { text: '😀', highlighted: true },
      { text: 'b', highlighted: false },
    ])
  })
  it('merges overlaps and clamps out-of-range offsets', () => {
    expect(
      splitMessageSnippet('abcdef', [
        { start: 2, end: 5 },
        { start: -4, end: 3 },
        { start: 4, end: 99 },
      ]),
    ).toEqual([{ text: 'abcdef', highlighted: true }])
  })
  it('ignores empty, reversed and outside ranges and preserves literal HTML', () => {
    expect(
      splitMessageSnippet('<b>safe</b>', [
        { start: 20, end: 30 },
        { start: 3, end: 2 },
        { start: 1, end: 1 },
      ]),
    ).toEqual([{ text: '<b>safe</b>', highlighted: false }])
    expect(splitMessageSnippet('', [])).toEqual([])
  })
})
