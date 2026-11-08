import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PushNotificationPayload } from '@opencode-manager/shared/types'
import type { SessionGoal } from '@opencode-manager/shared/schemas'
import { migrate } from '../../src/db/migration-runner'
import { allMigrations } from '../../src/db/migrations'
import { NotificationService } from '../../src/services/notification'
import { SettingsService } from '../../src/services/settings'
import { sseAggregator, type SSEEvent } from '../../src/services/sse-aggregator'
import { TelegramNotificationTransport } from '../../src/services/telegram-notification'

const sendResult = { delivered: 1, expired: 0, failed: 0, total: 1 }
const events = { permissionAsked: true, questionAsked: true, sessionError: true, sessionIdle: true }
const formCreated: SSEEvent = {
  id: 'evt_form_locale',
  created: 1700000000000,
  type: 'form.created',
  location: { directory: '/abs/unknown' },
  data: { form: { id: 'form-1', sessionID: 'ses_locale', title: '', fields: [{ key: 'confirm', type: 'string' }] } },
}

function subscribe(db: Database, service: NotificationService, userId: string, locale?: 'ko' | 'en') {
  service.saveSubscription(userId, `https://push.example.com/${userId}`, 'p256dh-key', 'auth-key')
  new SettingsService(db).updateSettings({ ...(locale ? { locale } : {}), notifications: { enabled: true, events } }, userId)
}

describe('NotificationService locale delivery', () => {
  let db: Database

  beforeEach(() => {
    sseAggregator.shutdown()
    db = new Database(':memory:')
    migrate(db, allMigrations)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('sends each push subscriber the notification in their own locale, defaulting to Korean', async () => {
    const service = new NotificationService(db)
    vi.spyOn(service, 'isConfigured').mockReturnValue(true)
    subscribe(db, service, 'user-ko', 'ko')
    subscribe(db, service, 'user-en', 'en')
    subscribe(db, service, 'user-default')
    const send = vi.spyOn(service, 'sendToUser').mockResolvedValue(sendResult)

    await service.handleSSEEvent(null, formCreated)

    const delivered = Object.fromEntries(
      send.mock.calls.map(([userId, payload]) => [userId, [payload.title, payload.body]]),
    )
    expect(delivered).toEqual({
      'user-ko': ['질문', '답해야 할 질문이 있습니다'],
      'user-en': ['Question', 'A question needs your answer'],
      'user-default': ['질문', '답해야 할 질문이 있습니다'],
    })
  })

  it('reports a Korean goal outcome with a localized stop reason', async () => {
    const service = new NotificationService(db)
    vi.spyOn(service, 'isConfigured').mockReturnValue(true)
    subscribe(db, service, 'user-ko', 'ko')
    const send = vi.spyOn(service, 'sendToUser').mockResolvedValue(sendResult)
    const goal: SessionGoal = {
      id: 7,
      sessionId: 'ses_goal_locale',
      serverId: 'local',
      directory: '/abs/unknown',
      objective: 'Ship the feature',
      status: 'stopped',
      stopReason: 'token_budget',
      turnState: 'waiting',
      continuationCount: 2,
      maxContinuations: 5,
      tokenBudget: 1000,
      tokensUsed: 1000,
      consecutiveBlocked: 0,
      lastVerdict: 'continue',
      lastReason: 'Keep working',
      createdAt: 1,
      updatedAt: 2,
      finishedAt: 3,
    }

    await service.notifyGoalOutcome(goal)

    const payload = send.mock.calls[0]?.[1] as PushNotificationPayload
    expect([payload.title, payload.body]).toEqual(['목표 중지', 'Ship the feature — 토큰 예산에 도달함'])
  })

  it.each([
    ['ko', '질문', 'Manager에서 열기'],
    ['en', 'Question', 'Open in Manager'],
  ] as const)('writes the Telegram message and button in the operator locale %s', async (locale, title, button) => {
    const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () => Response.json({ ok: true }))
    const transport = new TelegramNotificationTransport(
      { token: '123456:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '-100123456', origin: 'https://manager.example.com' },
      request,
    )
    new SettingsService(db).updateSettings({ locale }, 'default')
    const service = new NotificationService(db, null, transport)

    await service.handleSSEEvent(null, formCreated)

    const body = z
      .object({ text: z.string(), reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ text: z.string() }))) }) })
      .parse(JSON.parse(String(request.mock.calls[0]?.[1].body)))
    expect([body.text.split('\n')[0], body.reply_markup.inline_keyboard[0]?.[0]?.text]).toEqual([title, button])
  })
})
