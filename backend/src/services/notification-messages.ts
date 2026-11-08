import { getGoalOutcomeTitle, getGoalStopReasonLabel } from '@opencode-manager/shared/notifications'
import { DEFAULT_USER_PREFERENCES } from '@opencode-manager/shared/schemas'
import type { SessionGoalStatus, SessionGoalStopReason } from '@opencode-manager/shared/schemas'
import type { UserPreferences } from '@opencode-manager/shared/types'

export type NotificationLocale = NonNullable<UserPreferences['locale']>

export interface NotificationText {
  readonly questionTitle: string
  readonly questionBody: string
  readonly errorTitle: string
  readonly errorBody: string
  readonly idleTitle: string
  readonly idleBody: string
  readonly approvalBody: string
  readonly testTitle: string
  readonly pushTestBody: string
  readonly telegramTestBody: string
  readonly openInManager: string
  readonly permission: (label: string) => string
  readonly goalTitle: (status: SessionGoalStatus) => string
  readonly stopReason: (reason: SessionGoalStopReason) => string
}

const KOREAN_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'Read File': '파일 읽기',
  'Edit File': '파일 편집',
  'Search Files': '파일 검색',
  'Search Content': '내용 검색',
  'Run Command': '명령 실행',
  'Run Subagent': '하위 에이전트 실행',
  'External Access': '외부 경로 접근',
  'Ask Question': '질문 요청',
  'Fetch URL': 'URL 가져오기',
  'Web Search': '웹 검색',
  'Use Skill': '스킬 사용',
  Approval: '승인',
}

const KOREAN_GOAL_TITLES: Readonly<Record<SessionGoalStatus, string>> = {
  active: '목표 진행 중',
  paused: '목표 일시 정지',
  completed: '목표 달성',
  blocked: '목표 막힘',
  stopped: '목표 중지',
}

const KOREAN_STOP_REASONS: Readonly<Record<SessionGoalStopReason, string>> = {
  cancelled: '취소됨',
  user_paused: '사용자가 일시 정지함',
  continuation_limit: '계속 실행 한도에 도달함',
  token_budget: '토큰 예산에 도달함',
  turn_error: '턴 실패',
  interrupted: '중단됨',
  audit_failed: '판정 실패',
  session_deleted: '세션 삭제됨',
}

/** Notification copy per Manager locale; English entries reuse the shared source labels. */
export const NOTIFICATION_TEXT: Readonly<Record<NotificationLocale, NotificationText>> = {
  en: {
    questionTitle: 'Question',
    questionBody: 'A question needs your answer',
    errorTitle: 'Error',
    errorBody: 'A session encountered an error',
    idleTitle: 'Session complete',
    idleBody: 'Your session has finished processing',
    approvalBody: 'Approval required',
    testTitle: 'Test Notification',
    pushTestBody: 'Push notifications are working correctly',
    telegramTestBody: 'Telegram notifications are working correctly',
    openInManager: 'Open in Manager',
    permission: (label) => label,
    goalTitle: getGoalOutcomeTitle,
    stopReason: getGoalStopReasonLabel,
  },
  ko: {
    questionTitle: '질문',
    questionBody: '답해야 할 질문이 있습니다',
    errorTitle: '오류',
    errorBody: '세션에서 오류가 발생했습니다',
    idleTitle: '세션 완료',
    idleBody: '세션 처리가 끝났습니다',
    approvalBody: '승인이 필요합니다',
    testTitle: '테스트 알림',
    pushTestBody: '푸시 알림이 정상적으로 작동합니다',
    telegramTestBody: '텔레그램 알림이 정상적으로 작동합니다',
    openInManager: 'Manager에서 열기',
    permission: (label) => KOREAN_PERMISSION_LABELS[label] ?? label,
    goalTitle: (status) => KOREAN_GOAL_TITLES[status],
    stopReason: (reason) => KOREAN_STOP_REASONS[reason],
  },
}

/** Returns the notification locale stored in a user's preferences, falling back to the Manager default. */
export function preferredLocale(preferences: Pick<UserPreferences, 'locale'>): NotificationLocale {
  return preferences.locale ?? DEFAULT_USER_PREFERENCES.locale
}
