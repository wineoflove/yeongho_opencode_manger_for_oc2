import type { MessageSearchResponse } from '@opencode-manager/shared/schemas'

type MessageSearchHit = MessageSearchResponse['results'][number]

/** Splits a search snippet into plain and highlighted segments, clamping, merging and surrogate-pair-safe adjusting the server's ranges. */
export function splitMessageSnippet(
  snippet: string,
  highlights: MessageSearchHit['highlights'],
): { text: string; highlighted: boolean }[] {
  const splitsPair = (offset: number) =>
    offset > 0 &&
    offset < snippet.length &&
    /[\uD800-\uDBFF]/u.test(snippet[offset - 1]) &&
    /[\uDC00-\uDFFF]/u.test(snippet[offset])
  const ranges = highlights
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(({ start, end }) => {
      const lower = Math.max(0, Math.min(snippet.length, Math.trunc(start)))
      const upper = Math.max(0, Math.min(snippet.length, Math.trunc(end)))
      return { start: splitsPair(lower) ? lower - 1 : lower, end: splitsPair(upper) ? upper + 1 : upper }
    })
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start)
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  const segments: { text: string; highlighted: boolean }[] = []
  let cursor = 0
  for (const range of merged) {
    if (range.start > cursor) segments.push({ text: snippet.slice(cursor, range.start), highlighted: false })
    segments.push({ text: snippet.slice(range.start, range.end), highlighted: true })
    cursor = range.end
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), highlighted: false })
  return segments
}
