import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  UpdateTelegramSettingsRequestSchema,
  type TelegramSettingsResponse,
  type UpdateTelegramSettingsRequest,
} from '@opencode-manager/shared/schemas'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import {
  isPublicOrigin,
  parseTelegramConfig,
  readTelegramConfig,
  TelegramNotificationTransport,
  type TelegramRequest,
} from './telegram-notification'

const storedSchema = UpdateTelegramSettingsRequestSchema.extend({ botToken: z.string() })
const key = 'telegram-settings'

/** Raised when submitted Telegram settings are incomplete or unsafe. */
export class TelegramSettingsValidationError extends Error {
  constructor() {
    super('Invalid Telegram settings')
  }
}

/** Raised when stored Telegram settings cannot be read or written; callers fail closed. */
export class TelegramSettingsStoreError extends Error {
  constructor() {
    super('Telegram settings are unavailable')
  }
}

function validSettings(settings: z.infer<typeof storedSchema>): boolean {
  if (settings.enabled) {
    return (
      parseTelegramConfig({ token: settings.botToken, chatId: settings.chatId, origin: settings.publicUrl }) !== null
    )
  }
  return (
    (!settings.botToken || /^[1-9]\d*:[A-Za-z0-9_-]{20,}$/.test(settings.botToken)) &&
    (!settings.chatId || /^(?:-?[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(settings.chatId)) &&
    (!settings.publicUrl ||
      (z.string().url().safeParse(settings.publicUrl).success && isPublicOrigin(settings.publicUrl)))
  )
}

/** Stores Telegram settings encrypted in app_secrets and falls back to environment values until saved. */
export class TelegramSettingsService {
  constructor(
    private readonly db: Database,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly request?: TelegramRequest,
  ) {}

  private readEffective() {
    try {
      const row = this.db.query<{ value: string }, [string]>('SELECT value FROM app_secrets WHERE key = ?').get(key)
      if (row) {
        const settings = storedSchema.parse(JSON.parse(decryptSecret(row.value)))
        if (!validSettings(settings)) throw new TelegramSettingsStoreError()
        return { ...settings, source: 'db' as const }
      }
      const config = readTelegramConfig(this.env)
      return {
        enabled: config !== null,
        botToken: config?.token ?? '',
        chatId: config?.chatId ?? '',
        publicUrl: config?.origin ?? '',
        source: config ? ('env' as const) : ('none' as const),
      }
    } catch {
      throw new TelegramSettingsStoreError()
    }
  }

  getSettings(): TelegramSettingsResponse {
    const { botToken, ...metadata } = this.readEffective()
    return { ...metadata, hasBotToken: botToken.length > 0 }
  }

  updateSettings(input: UpdateTelegramSettingsRequest): TelegramSettingsResponse {
    const settings = { ...input, botToken: input.botToken ?? this.readEffective().botToken }
    if (!validSettings(settings)) throw new TelegramSettingsValidationError()
    try {
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO app_secrets (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, encryptSecret(JSON.stringify(settings)), now, now)
    } catch {
      throw new TelegramSettingsStoreError()
    }
    return {
      enabled: settings.enabled,
      hasBotToken: settings.botToken.length > 0,
      chatId: settings.chatId,
      publicUrl: settings.publicUrl,
      source: 'db',
    }
  }

  getTransport(): TelegramNotificationTransport | undefined {
    const settings = this.readEffective()
    if (!settings.enabled) return undefined
    const config = parseTelegramConfig({
      token: settings.botToken,
      chatId: settings.chatId,
      origin: settings.publicUrl,
    })
    if (!config) throw new TelegramSettingsStoreError()
    return new TelegramNotificationTransport(config, this.request)
  }
}
