import { describe, expect, it } from 'vitest'
import { assessClaudeTerminalReadiness } from '../../src/services/claude-terminal-readiness'

const idle = {
  schemaVersion: 1,
  ready: true,
  counts: { terminalSessions: 0 },
  blockers: [],
}

describe('separate terminal service maintenance readiness', () => {
  it('accepts only a verified idle response', () => {
    expect(assessClaudeTerminalReadiness({ status: 200, body: idle })).toEqual({
      ready: true,
      terminalSessions: 0,
      reason: null,
    })
  })
  it.each([false, true])('blocks terminal sessions even with ready=%s', (ready) => {
    expect(
      assessClaudeTerminalReadiness({
        status: 200,
        body: { ...idle, ready, counts: { terminalSessions: 2 } },
      }),
    ).toEqual({
      ready: false,
      terminalSessions: 2,
      reason: 'TERMINALS_PRESENT',
    })
  })
  it.each([
    { status: 401, body: idle },
    { status: 403, body: idle },
    { status: 404, body: idle },
    { status: 503, body: idle },
    { status: 200, body: null },
    { status: 200, body: { ...idle, counts: { terminalSessions: -1 } } },
    { status: 200, body: { ...idle, ready: false } },
    { status: 200, body: { ...idle, blockers: ['terminal_status_unknown'] } },
    { status: 200, body: { ...idle, counts: {} } },
  ])('fails closed on unavailable or inconsistent terminal evidence', (response) => {
    expect(assessClaudeTerminalReadiness(response)).toEqual({
      ready: false,
      terminalSessions: null,
      reason: 'TERMINAL_STATUS_UNVERIFIED',
    })
  })
})
