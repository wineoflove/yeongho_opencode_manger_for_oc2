import { describe, expect, it } from 'bun:test'
import { redact } from './data.mjs'
import { validateAnalysis, formatReport, failureNotice } from './contracts.mjs'

describe('learning review safety', () => {
  it('redacts secrets and contact data before analysis', () => {
    const output = redact('password=abc123 Bearer abc.def.ghi test@example.com ghp_abcd1234')
    for (const secret of ['abc123', 'abc.def.ghi', 'test@example.com', 'ghp_abcd1234'])
      expect(output).not.toContain(secret)
  })
  const lessonWith = (sourceIds) => ({
    patternKey: 'test.error',
    kind: 'error',
    lesson: '',
    conditions: '',
    evidence: '',
    limits: '',
    sourceIds,
  })
  const realRecords = Array.from({ length: 8 }, (_, index) => ({ id: `real_${index}` }))
  it('drops a lesson whose sources were never collected instead of failing the batch', () => {
    const analysis = validateAnalysis(
      { summary: '', recurring: [], uncertainties: [], suggestions: [], lessons: [lessonWith(['invented'])] },
      realRecords,
    )
    expect(analysis.lessons).toEqual([])
    expect(analysis.adjustments.join('\n')).toContain('invented')
  })
  it('removes an uncollected source before truncation so it is never recorded', () => {
    const sourceIds = [...realRecords.map((record) => record.id), 'invented']
    const analysis = validateAnalysis(
      { summary: '', recurring: [], uncertainties: [], suggestions: [], lessons: [lessonWith(sourceIds)] },
      realRecords,
    )
    expect(analysis.lessons[0].sourceIds).toEqual(realRecords.map((record) => record.id))
    expect(analysis.lessons[0].limits).toContain('수집되지 않은 근거 1개')
    expect(analysis.adjustments.join('\n')).toContain('invented')
  })
  it('drops policy findings that cite an uncollected instruction', () => {
    const analysis = validateAnalysis(
      {
        summary: '',
        recurring: [],
        uncertainties: [],
        suggestions: [],
        lessons: [],
        policyFindings: [
          { sourceId: 'policy/real', action: 'keep', reason: 'ok' },
          { sourceId: 'policy/invented', action: 'remove', reason: 'stale' },
        ],
      },
      [{ id: 'policy/real', kind: 'current-instruction' }],
    )
    expect(analysis.policyFindings.map((item) => item.sourceId)).toEqual(['policy/real'])
    expect(analysis.adjustments.join('\n')).toContain('policy/invented')
  })
  it('gives each failure notice its own message ID so a later failure is not rejected as a conflict', () => {
    const now = 1_792_900_000_000
    const first = failureNotice('daily', 'batch-a', 'error one', now)
    const sameErrorNextDay = failureNotice('daily', 'batch-a', 'error one', now + 86_400_000)
    const differentError = failureNotice('daily', 'batch-a', 'error two', now)
    expect(new Set([first.messageID, sameErrorNextDay.messageID, differentError.messageID]).size).toBe(3)
    expect(first.messageID).toMatch(/^msg_[0-9a-f]{26}$/)
    expect(first.text).toContain('error one')
  })
  it('rejects policy editing instructions as unknown output fields', () => {
    expect(() =>
      validateAnalysis(
        { summary: '', recurring: [], uncertainties: [], suggestions: [], lessons: [], editPolicy: true },
        [],
      ),
    ).toThrow()
  })
  it('keeps a lesson that cites more sources than the limit instead of failing the batch', () => {
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `msg_${index}` }))
    const analysis = validateAnalysis(
      {
        summary: 'fixture',
        recurring: [],
        uncertainties: [],
        suggestions: [],
        lessons: [
          {
            patternKey: 'test.many-sources',
            kind: 'error',
            lesson: 'lesson',
            conditions: 'conditions',
            evidence: 'evidence',
            limits: 'limits',
            sourceIds: [...records.map((record) => record.id), 'msg_0'],
          },
        ],
      },
      records,
    )
    expect(analysis.lessons[0].sourceIds).toEqual(records.slice(0, 8).map((record) => record.id))
    expect(analysis.lessons[0].limits).toContain('12')
    expect(analysis.adjustments).toHaveLength(1)
    expect(formatReport('daily', { records, more: false }, analysis, 'date', 1)).toContain(analysis.adjustments[0])
  })
  it('caps overflowing lists, lessons and long text to the contract limits', () => {
    const lesson = {
      patternKey: 'test.cap',
      kind: 'error',
      lesson: 'x'.repeat(2500),
      conditions: '',
      evidence: '',
      limits: '',
      sourceIds: ['real'],
    }
    const analysis = validateAnalysis(
      {
        summary: 's'.repeat(2000),
        recurring: Array.from({ length: 11 }, (_, index) => `item ${index}`),
        uncertainties: [],
        suggestions: [],
        lessons: Array.from({ length: 7 }, () => lesson),
      },
      [{ id: 'real' }],
    )
    expect(analysis.summary.length).toBeLessThanOrEqual(1800)
    expect(analysis.recurring).toHaveLength(8)
    expect(analysis.lessons).toHaveLength(5)
    expect(analysis.lessons[0].lesson.length).toBeLessThanOrEqual(1800)
    expect(analysis.adjustments.length).toBeGreaterThanOrEqual(3)
  })
  it('accepts a report without adding learned entries', () => {
    const analysis = validateAnalysis(
      { summary: 'No new evidence', recurring: [], uncertainties: [], suggestions: [], lessons: [] },
      [],
    )
    expect(analysis.lessons).toHaveLength(0)
    expect(typeof formatReport('daily', { records: [], more: false }, analysis, '2026-09-13', 0)).toBe('string')
  })
})
