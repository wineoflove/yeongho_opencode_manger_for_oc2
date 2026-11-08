import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { readTelegramConfig, TelegramNotificationTransport } from '../../src/services/telegram-notification'
import { logger } from '../../src/utils/logger'

const env = {
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyzABCDE',
  TELEGRAM_CHAT_ID: '-100123456',
  OCM_PUBLIC_URL: 'https://manager.example.com',
}
const config = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, origin: env.OCM_PUBLIC_URL }
const payload = {
  title: '처리 종료',
  body: '<plain> *text*',
  data: { eventType: 'session.idle', url: '/repos/0/sessions/ses_1?assistant=1' },
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Telegram configuration', () => {
  it('disables silently when all values are empty', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(readTelegramConfig({})).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    'http://manager.example.com',
    'https://localhost',
    'https://sub.localhost',
    'https://127.1',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.1.1',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com/#fragment',
    'https://example.com/?',
    'https://example.com/#',
  ])('rejects unsafe origin %s without exposing configuration', (origin) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(readTelegramConfig({ ...env, OCM_PUBLIC_URL: origin })).toBeNull()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(origin)
  })

  it.each([{ TELEGRAM_CHAT_ID: '' }, { TELEGRAM_BOT_TOKEN: 'bad/token' }, { TELEGRAM_CHAT_ID: 'bad chat' }])(
    'disables partial or malformed configuration %j',
    (override) => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      expect(readTelegramConfig({ ...env, ...override })).toBeNull()
    },
  )

  it.each(['https://manager.example.com/', 'https://8.8.8.8', 'https://[2606:4700:4700::1111]'])(
    'accepts external HTTPS origin %s',
    (origin) => {
      expect(readTelegramConfig({ ...env, OCM_PUBLIC_URL: origin })?.origin).toBe(new URL(origin).origin)
    },
  )
})

describe('Telegram transport', () => {
  it('aborts the request using a ten-second timeout signal', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const request = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')), {
            once: true,
          })
        }),
    )
    const delivery = new TelegramNotificationTransport(config, request).send(payload)
    controller.abort()
    expect(await delivery).toBe(false)
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('sends one plain text message with a visible absolute link and matching button', async () => {
    const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    )
    expect(await new TelegramNotificationTransport(config, request).send({ ...payload, body: 'x'.repeat(5000) })).toBe(
      true,
    )
    expect(request).toHaveBeenCalledTimes(1)
    const call = request.mock.calls[0]
    expect(call?.[0]).toBe(`https://api.telegram.org/bot${config.token}/sendMessage`)
    expect(call?.[1].redirect).toBe('error')
    expect(call?.[1].signal).toBeInstanceOf(AbortSignal)
    const body = z
      .object({
        text: z.string().max(4096),
        chat_id: z.string(),
        parse_mode: z.undefined().optional(),
        link_preview_options: z.object({ is_disabled: z.literal(true) }),
        reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ text: z.string(), url: z.string() }))) }),
      })
      .parse(JSON.parse(String(call?.[1].body)))
    expect(body.chat_id).toBe(config.chatId)
    expect(body.text.endsWith(`${config.origin}${payload.data.url}`)).toBe(true)
    expect(body.reply_markup.inline_keyboard[0]?.[0]?.url).toBe(`${config.origin}${payload.data.url}`)
  })

  it.each(['//evil.example/', '/\\evil.example/', 'https://evil.example/', 'javascript:alert(1)', '/\nevil'])(
    'rejects malicious link %s before any request',
    async (url) => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const request = vi.fn(async () => Response.json({ ok: true }))
      expect(
        await new TelegramNotificationTransport(config, request).send({ ...payload, data: { ...payload.data, url } }),
      ).toBe(false)
      expect(request).not.toHaveBeenCalled()
    },
  )

  it.each([
    () => Promise.resolve(new Response(config.token, { status: 429 })),
    () => Promise.resolve(Response.json({ ok: false, description: config.token })),
    () => Promise.resolve(new Response('invalid JSON')),
    () => Promise.reject(new Error(config.token)),
    () => Promise.reject(new DOMException(config.token, 'TimeoutError')),
  ])('reports failure without retrying or leaking error details', async (response) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const request = vi.fn(response)
    expect(await new TelegramNotificationTransport(config, request).send(payload)).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.token)
  })
})
