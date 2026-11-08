import { describe, it, expect } from 'vitest'
import { setLocale } from './locale'
import { describeError } from './errors'
import { KO } from './ko'

const OCM_MESSAGES = [
  'AGENT_NOT_AVAILABLE: agent oracle missing',
  'AGENT_CHECK_FAILED',
  'RUN_DEADLINE_EXCEEDED after 600s',
  'USAGE_SESSION_NOT_FOUND',
  'USAGE_SOURCE_INCOMPATIBLE',
  'USAGE_SNAPSHOT_FAILED',
  'WORKFLOW_SOURCE_INCOMPATIBLE',
  'OCM_OUTCOME_NO_RUNNING_RUN',
  'SYSTEM_STATUS_INVALID',
  'LEARNING_RECORD_NOT_FOUND',
  'LEARNING_RECORD_INVALID: bad id',
]

const OPENCODE_NAMES = [
  'ProviderAuthError',
  'UnknownError',
  'MessageOutputLengthError',
  'MessageAbortedError',
  'APIError',
]

describe('describeError', () => {
  it('describes known codes and names with korean titles in ko', () => {
    setLocale('ko')

    for (const message of [...OCM_MESSAGES, ...OPENCODE_NAMES]) {
      const described = describeError(message)
      expect(described.detail).toBe(message)
      expect(described.title).not.toBe('요청에 실패했습니다')
      expect(Object.values(KO)).toContain(described.title)
    }
  })

  it('keeps english titles in en', () => {
    const described = describeError('AGENT_NOT_AVAILABLE: x')

    expect(Object.keys(KO)).toContain(described.title)
    expect(described.detail).toBe('AGENT_NOT_AVAILABLE: x')
  })

  it('falls back to Request failed', () => {
    expect(describeError('boom')).toEqual({ title: 'Request failed', detail: 'boom' })
    setLocale('ko')
    expect(describeError('boom')).toEqual({ title: '요청에 실패했습니다', detail: 'boom' })
  })

  it('requires an exact OpenCode error name', () => {
    setLocale('ko')

    expect(describeError('APIError happened').title).toBe('요청에 실패했습니다')
  })
})
