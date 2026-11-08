import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USER_PREFERENCES, TelegramSettingsResponseSchema } from '@opencode-manager/shared/schemas'
import { TelegramSettingsService, TelegramSettingsStoreError } from '../../src/services/telegram-settings'
import { NotificationService } from '../../src/services/notification'
import { SettingsService } from '../../src/services/settings'
import { createNotificationRoutes } from '../../src/routes/notifications'
import { encryptSecret } from '../../src/utils/crypto'
import type { SSEEvent } from '../../src/services/sse-aggregator'
import { allMigrations } from '../../src/db/migrations'
import { migrate } from '../../src/db/migration-runner'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { createInternalTestApp } from '../helpers/internal-test-app'

const env = {
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyzABCDE',
  TELEGRAM_CHAT_ID: '-100123456',
  OCM_PUBLIC_URL: 'https://manager.example.com',
}
const enabled = { enabled: true, chatId: '-100987654', publicUrl: 'https://other.example.com' }
const disabled = { enabled: false, chatId: '', publicUrl: '', botToken: '' }
const formCreated = {
  type: 'form.created',
  data: { form: { sessionID: 'ses_telegram', title: '배포 순서를 확인해 주세요' } },
} as unknown as SSEEvent

describe('persistent Telegram settings', () => {
  let db: Database
  let settings: TelegramSettingsService
  let notifications: NotificationService
  let app: ReturnType<typeof createNotificationRoutes>
  const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () =>
    Response.json({ ok: true }),
  )

  beforeEach(() => {
    db = new Database(':memory:')
    db.run(
      'CREATE TABLE app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)',
    )
    request.mockReset()
    request.mockImplementation(async () => Response.json({ ok: true }))
    settings = new TelegramSettingsService(db, env, request)
    notifications = new NotificationService(db, null, () => settings.getTransport())
    app = createNotificationRoutes(notifications, settings)
    vi.spyOn(SettingsService.prototype, 'getSettings').mockReturnValue({
      preferences: { ...DEFAULT_USER_PREFERENCES },
      updatedAt: 0,
    })
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('encrypts the entire configuration and reloads it in a new service', () => {
    settings.updateSettings(enabled)
    const bytes = JSON.stringify(db.query('SELECT * FROM app_secrets').all())
    const reloaded = new TelegramSettingsService(db, {}, request).getSettings()
    for (const plaintext of [env.TELEGRAM_BOT_TOKEN, enabled.chatId, enabled.publicUrl, 'botToken']) {
      expect(bytes).not.toContain(plaintext)
    }
    expect(reloaded).toEqual({ ...enabled, hasBotToken: true, source: 'db' })
  })

  it('uses environment only before any saved row exists', () => {
    expect(settings.getSettings().source).toBe('env')
    expect(new TelegramSettingsService(db, {}).getSettings()).toEqual({
      enabled: false,
      hasBotToken: false,
      chatId: '',
      publicUrl: '',
      source: 'none',
    })
    settings.updateSettings(disabled)
    expect(settings.getTransport()).toBeUndefined()
    expect(new TelegramSettingsService(db, env).getSettings().source).toBe('db')
  })

  it('preserves omitted stored token rather than the environment token', async () => {
    const token = '999999:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde'
    settings.updateSettings({ ...enabled, botToken: token })
    settings.updateSettings({ ...enabled, chatId: '-100555555' })
    await settings.getTransport()?.send({ title: 'test', body: 'test' })
    expect(request.mock.calls[0]?.[0]).toContain(token)
    expect(request.mock.calls[0]?.[1].body).toContain('-100555555')
  })

  it('clears a token only while disabled and rejects re-enabling without a token', async () => {
    settings.updateSettings(disabled)
    const response = await app.request('/telegram', { method: 'PUT', body: JSON.stringify(enabled) })
    expect(response.status).toBe(400)
    expect(settings.getSettings().hasBotToken).toBe(false)
  })

  it('returns only redacted metadata from GET and PUT', async () => {
    const original = await app.request('/telegram')
    expect(TelegramSettingsResponseSchema.parse(await original.json()).source).toBe('env')
    const response = await app.request('/telegram', { method: 'PUT', body: JSON.stringify(enabled) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...enabled, hasBotToken: true, source: 'db' })
  })

  it.each([
    { ...enabled, publicUrl: 'http://example.com/secret' },
    { ...enabled, publicUrl: 'https://localhost' },
    { ...enabled, publicUrl: 'https://user:secret@example.com' },
    { ...enabled, botToken: 'secret-invalid-token' },
    { ...enabled, botToken: '' },
    { ...enabled, chatId: 'secret-invalid-chat' },
    { ...enabled, enabled: 'secret-invalid-enabled' },
    { ...enabled, unexpected: 'secret-extra-field' },
  ])('rejects invalid inputs without echoing values', async (input) => {
    const response = await app.request('/telegram', { method: 'PUT', body: JSON.stringify(input) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid Telegram settings' })
    expect(settings.getSettings().source).toBe('env')
  })

  it('rejects malformed JSON without echoing the body', async () => {
    const response = await app.request('/telegram', { method: 'PUT', body: 'secret-invalid-json' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid Telegram settings' })
  })

  it('tests the latest saved chat without push or request-body credentials', async () => {
    settings.updateSettings(enabled)
    const push = vi.spyOn(notifications, 'sendToUser')
    const response = await app.request('/telegram/test', {
      method: 'POST',
      body: JSON.stringify({ botToken: 'ignored', chatId: 'ignored' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: 'sent' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1].body).toContain(enabled.chatId)
    expect(request.mock.calls[0]?.[1].body).toContain(`${enabled.publicUrl}/?settings=open&settingsTab=notifications`)
    expect(push).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not request Telegram when unconfigured or saved disabled (%s)', async (saved) => {
    if (saved) settings.updateSettings(disabled)
    const effective = saved ? settings : new TelegramSettingsService(db, {}, request)
    const routes = createNotificationRoutes(notifications, effective)
    const response = await routes.request('/telegram/test', { method: 'POST' })
    expect(await response.json()).toEqual({ ok: false, status: 'not_configured' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([Response.json({ ok: false, description: env.TELEGRAM_BOT_TOKEN }), new Response('secret', { status: 500 })])(
    'reports failed test delivery with HTTP 200',
    async (providerResponse) => {
      request.mockResolvedValue(providerResponse)
      const response = await app.request('/telegram/test', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: false, status: 'failed' })
    },
  )

  it('uses current settings and correct statistics on each normal dispatch', async () => {
    settings.updateSettings(enabled)
    expect(await notifications.sendNotification('default', { title: 'test', body: 'test' })).toEqual({
      delivered: 1,
      expired: 0,
      failed: 0,
      total: 1,
    })
    settings.updateSettings({ ...enabled, chatId: '-100222222' })
    request.mockResolvedValue(Response.json({ ok: false }))
    expect(await notifications.sendNotification('default', { title: 'test', body: 'test' })).toEqual({
      delivered: 0,
      expired: 0,
      failed: 1,
      total: 1,
    })
    expect(request.mock.calls[1]?.[1].body).toContain('-100222222')
    settings.updateSettings(disabled)
    expect(await notifications.sendNotification('default', { title: 'test', body: 'test' })).toEqual({
      delivered: 0,
      expired: 0,
      failed: 0,
      total: 0,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(['invalid ciphertext', encryptSecret('{"botToken":"secret-invalid-config"}')])(
    'fails closed on corrupted storage without environment fallback',
    async (value) => {
      db.prepare('INSERT INTO app_secrets VALUES (?, ?, 0, 0)').run('telegram-settings', value)
      expect(() => settings.getTransport()).toThrow(TelegramSettingsStoreError)
      for (const [url, method] of [
        ['/telegram', 'GET'],
        ['/telegram/test', 'POST'],
      ] as const) {
        const response = await app.request(url, { method })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Telegram settings are unavailable' })
      }
      await notifications.sendNotification('default', { title: 'test', body: 'test' })
      expect(request).not.toHaveBeenCalled()
    },
  )

  it('sanitizes database failures', async () => {
    db.run('DROP TABLE app_secrets')
    const response = await app.request('/telegram', {
      method: 'PUT',
      body: JSON.stringify({ ...enabled, botToken: env.TELEGRAM_BOT_TOKEN }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Telegram settings are unavailable' })
  })

  it('applies saved changes to SSE dispatch without recreating the notification service', async () => {
    settings.updateSettings({ ...enabled, chatId: '-100333333' })
    await notifications.handleSSEEvent(null, formCreated)
    expect(request.mock.calls[0]?.[1].body).toContain('-100333333')
    settings.updateSettings(disabled)
    await notifications.handleSSEEvent(null, formCreated)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps push delivery independent when encrypted Telegram settings are corrupt', async () => {
    db.prepare('INSERT INTO app_secrets VALUES (?, ?, 0, 0)').run('telegram-settings', 'corrupted')
    vi.spyOn(notifications, 'isConfigured').mockReturnValue(true)
    const push = vi
      .spyOn(notifications, 'sendToUser')
      .mockResolvedValue({ delivered: 1, expired: 0, failed: 0, total: 1 })
    const result = await notifications.sendNotification('default', { title: 'test', body: 'test' })
    expect(result).toEqual({ delivered: 1, expired: 0, failed: 0, total: 1 })
    expect(push).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('delivers assistant notifications through Telegram when Web Push is not configured', async () => {
    const internalDb = new Database(':memory:')
    migrate(internalDb, allMigrations)
    const internalSettings = new TelegramSettingsService(internalDb, env, request)
    const internalNotifications = new NotificationService(internalDb, null, () => internalSettings.getTransport())
    const internal = createInternalTestApp(internalDb, { notificationService: internalNotifications })
    const token = getOrCreateInternalToken(internalDb)

    const response = await internal.request('/notifications/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '보고서 게시', body: '일일 점검 완료' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivered: 1, expired: 0, failed: 0, noSubscriptions: false })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1].body).toContain('보고서 게시')
    internalDb.close()
  })

  it('reports no channel when neither Web Push nor Telegram is configured', async () => {
    const internalDb = new Database(':memory:')
    migrate(internalDb, allMigrations)
    const internalNotifications = new NotificationService(internalDb, null, () => undefined)
    const internal = createInternalTestApp(internalDb, { notificationService: internalNotifications })
    const token = getOrCreateInternalToken(internalDb)

    const response = await internal.request('/notifications/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', body: 'b' }),
    })

    expect(response.status).toBe(503)
    expect(request).not.toHaveBeenCalled()
    internalDb.close()
  })
})
