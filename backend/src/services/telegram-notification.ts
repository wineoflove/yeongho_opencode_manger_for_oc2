import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import type { PushNotificationPayload } from '@opencode-manager/shared/types'
import { logger } from '../utils/logger'
import { NOTIFICATION_TEXT, type NotificationLocale } from './notification-messages'

const configSchema = z.object({
  token: z.string().regex(/^[1-9]\d*:[A-Za-z0-9_-]{20,}$/),
  chatId: z.string().regex(/^(?:-?[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{4,})$/),
  origin: z.string().url(),
})

export type TelegramConfig = Readonly<z.infer<typeof configSchema>>
export type TelegramRequest = (url: string, options: RequestInit) => Promise<Response>

/** Accepts only a bare public HTTPS origin, so notification links never point at private hosts. */
export function isPublicOrigin(value: string): boolean {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false
  if (!/^https:\/\/[^/?#\\@\s]+\/?$/.test(value) || url.pathname !== '/') return false
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (isIP(host) === 6) {
    const globalUnicast = new BlockList()
    globalUnicast.addSubnet('2000::', 3, 'ipv6')
    return globalUnicast.check(host, 'ipv6')
  }
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return false
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number)
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    )
  }
  return true
}

/** Reads the Telegram configuration from TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and OCM_PUBLIC_URL. */
export function readTelegramConfig(env: Readonly<Record<string, string | undefined>>): TelegramConfig | null {
  const values = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.OCM_PUBLIC_URL]
  if (values.every((value) => !value?.trim())) return null
  const parsed = configSchema.safeParse({ token: values[0], chatId: values[1], origin: values[2] })
  if (!parsed.success || !isPublicOrigin(parsed.data.origin)) {
    logger.warn(
      'Telegram disabled: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and OCM_PUBLIC_URL must all be valid; OCM_PUBLIC_URL must be a public HTTPS origin',
    )
    return null
  }
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin }
}

/** Validates a stored Telegram configuration, returning null when any field is unusable. */
export function parseTelegramConfig(value: unknown): TelegramConfig | null {
  const parsed = configSchema.safeParse(value)
  if (!parsed.success || !isPublicOrigin(parsed.data.origin)) return null
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin }
}

/** Sends one plain-text Telegram message per notification, linking back to the Manager page. */
export class TelegramNotificationTransport {
  constructor(
    private readonly config: TelegramConfig,
    private readonly request: TelegramRequest = (url, options) => fetch(url, options),
  ) {}

  async send(payload: PushNotificationPayload, locale: NotificationLocale = 'en'): Promise<boolean> {
    try {
      const internalUrl = payload.data?.url ?? '/'
      const url = new URL(internalUrl, this.config.origin)
      if (
        !internalUrl.startsWith('/') ||
        internalUrl.startsWith('//') ||
        /[\\\r\n\t]/.test(internalUrl) ||
        url.origin !== this.config.origin ||
        url.username ||
        url.password ||
        url.href.length > 4000
      ) {
        logger.warn('Telegram delivery rejected: invalid notification URL')
        return false
      }
      const content = `${payload.title}\n${payload.body}`
      const text = `${content.slice(0, 4096 - url.href.length - 2)}\n\n${url.href}`
      const response = await this.request(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[{ text: NOTIFICATION_TEXT[locale].openInManager, url: url.href }]] },
        }),
      })
      if (!response.ok) {
        logger.warn('Telegram delivery failed: HTTP response was unsuccessful')
        return false
      }
      const result = z.object({ ok: z.literal(true) }).safeParse(await response.json())
      if (!result.success) logger.warn('Telegram delivery failed: API did not confirm delivery')
      return result.success
    } catch (error) {
      logger.warn(
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'Telegram delivery failed: request timed out'
          : 'Telegram delivery failed: request or response could not be processed',
      )
      return false
    }
  }
}
