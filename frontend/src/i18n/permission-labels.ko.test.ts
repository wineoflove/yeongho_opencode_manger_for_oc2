import { describe, it, expect, afterEach } from 'vitest'
import { getPermissionLabel } from '@opencode-manager/shared/notifications'
import { setLocale } from './locale'
import { t } from './translate'

const PERMISSION_KO_LABELS: Record<string, string> = {
  read: '파일 읽기',
  edit: '파일 편집',
  glob: '파일 검색',
  grep: '내용 검색',
  shell: '명령 실행',
  subagent: '하위 에이전트 실행',
  external_directory: '외부 경로 접근',
  question: '질문 요청',
  webfetch: 'URL 가져오기',
  websearch: '웹 검색',
  skill: '스킬 사용',
  '': '승인',
}

describe('Korean permission labels', () => {
  afterEach(() => {
    setLocale('en')
  })

  it('covers every distinct permission label', () => {
    const labels = Object.keys(PERMISSION_KO_LABELS).map(getPermissionLabel)

    expect(new Set(labels).size).toBe(Object.keys(PERMISSION_KO_LABELS).length)
  })

  it.each(Object.entries(PERMISSION_KO_LABELS))(
    'translates the %j permission label to %s',
    (permission, expected) => {
      setLocale('ko')

      expect(t(getPermissionLabel(permission))).toBe(expected)
    },
  )

  it('keeps the English label in en', () => {
    setLocale('en')

    expect(t(getPermissionLabel('external_directory'))).toBe('External Access')
  })
})
