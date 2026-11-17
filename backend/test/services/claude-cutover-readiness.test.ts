import { describe, expect, it } from 'vitest'
import { evaluateClaudeCutoverReadiness } from '../../src/services/claude-cutover-readiness'

const counts = {
  enabledSchedules: 0,
  activeSchedules: 0,
  activeRecovery: 0,
  busySessions: 0,
  checkedDirectories: 2,
}
const ready = { schemaVersion: 1, ready: true, counts, blockers: [] }

describe('external Claude cutover readiness', () => {
  it.each([401, 403])('treats HTTP %i as unverified rather than idle', (status) => {
    expect(evaluateClaudeCutoverReadiness({ status, body: ready }, true)).toEqual({
      ready: false,
      reason: 'STATUS_ACCESS_UNCONFIRMED',
    })
  })
  it.each(['enabledSchedules', 'activeSchedules', 'activeRecovery', 'busySessions'])(
    'does not trust ready=true while %s is nonzero',
    (field) => {
      expect(
        evaluateClaudeCutoverReadiness({ status: 200, body: { ...ready, counts: { ...counts, [field]: 1 } } }, true),
      ).toEqual({ ready: false, reason: 'WORK_ACTIVE' })
    },
  )
  it('rejects an empty directory inventory', () => {
    expect(
      evaluateClaudeCutoverReadiness(
        {
          status: 200,
          body: { ...ready, counts: { ...counts, checkedDirectories: 0 } },
        },
        true,
      ),
    ).toEqual({ ready: false, reason: 'STATUS_INVALID' })
  })
  it('does not equate an idle snapshot with an admission fence', () => {
    expect(evaluateClaudeCutoverReadiness({ status: 200, body: ready }, false)).toEqual({
      ready: false,
      reason: 'ADMISSION_NOT_FENCED',
    })
    expect(evaluateClaudeCutoverReadiness({ status: 200, body: ready }, true)).toEqual({ ready: true, counts })
  })
})
