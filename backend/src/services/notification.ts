import { Database } from "bun:sqlite";
import webpush from "web-push";
import { logger } from "../utils/logger";
import type { PushSubscriptionRecord } from "../types/settings";
import type {
  NotificationPreferences,
  PushNotificationPayload,
} from "@opencode-manager/shared/types";
import {
  NotificationEventType,
  DEFAULT_NOTIFICATION_PREFERENCES,
  LOCAL_OPENCODE_SERVER_ID,
  type OpenCodeServer,
  type SessionGoal,
} from "@opencode-manager/shared/schemas";
import {
  getPermissionLabel,
  getPermissionDetail,
  getFormText,
} from "@opencode-manager/shared/notifications";
import { SettingsService } from "./settings";
import {
  NOTIFICATION_TEXT,
  preferredLocale,
  type NotificationLocale,
  type NotificationText,
} from "./notification-messages";
import { sseAggregator, type SSEEvent } from "./sse-aggregator";
import { getRepoName } from "../db/queries";
import { getScheduleRunBySessionId } from "../db/schedules";
import { ensurePushSubscriptionsTable } from "../db/push-subscriptions";
import { isAuthSessionActive } from "../db/auth-sessions";
import type { Repo } from "../types/repo";
import { buildServerSessionPath, buildSessionPath } from "@opencode-manager/shared/utils";
import { sessionIDFromEvent } from "@opencode-manager/shared/opencode";
import { resolveRepoForDirectory } from "./repo";
import type { TelegramNotificationTransport } from "./telegram-notification";
import { TelegramSettingsStoreError } from "./telegram-settings";
import type { TelegramTestNotificationResponse } from "@opencode-manager/shared/schemas";

export interface NotificationServerRegistry {
  get(serverId: string): Pick<OpenCodeServer, "name" | "enabled"> | null;
}

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const EVENT_CONFIG: Record<
  string,
  {
    preferencesKey: keyof typeof DEFAULT_NOTIFICATION_PREFERENCES.events;
    titleFn: (data: Record<string, unknown>, text: NotificationText) => string;
    bodyFn: (data: Record<string, unknown>, text: NotificationText) => string;
  }
> = {
  [NotificationEventType.PERMISSION_ASKED]: {
    preferencesKey: "permissionAsked",
    titleFn: (data, text) =>
      text.permission(getPermissionLabel(typeof data.action === "string" ? data.action : "")),
    bodyFn: (data, text) => getPermissionDetail(data).primary || text.approvalBody,
  },
  [NotificationEventType.FORM_CREATED]: {
    preferencesKey: "questionAsked",
    titleFn: (_data, text) => text.questionTitle,
    bodyFn: (data, text) => getFormText(data.form as { title?: unknown }) || text.questionBody,
  },
  [NotificationEventType.SESSION_FAILED]: {
    preferencesKey: "sessionError",
    titleFn: (_data, text) => text.errorTitle,
    bodyFn: (data, text) => {
      const error = data.error as { message?: string } | undefined;
      return error?.message ?? text.errorBody;
    },
  },
  [NotificationEventType.SESSION_IDLE]: {
    preferencesKey: "sessionIdle",
    titleFn: (_data, text) => text.idleTitle,
    bodyFn: (_data, text) => text.idleBody,
  },
};

const MAX_BODY_LENGTH = 140;

const RUN_OUTCOME_EVENTS = new Set<string>([
  NotificationEventType.SESSION_IDLE,
  NotificationEventType.SESSION_FAILED,
]);

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildGoalOutcomeBody(goal: SessionGoal, repoName: string | undefined, text: NotificationText): string {
  const reason = (goal.stopReason ? text.stopReason(goal.stopReason) : goal.lastReason)?.trim() || undefined;
  const prefix = repoName ? `${repoName} · ` : "";
  const separator = " — ";

  const reasonBudget = Math.max(0, MAX_BODY_LENGTH - prefix.length - separator.length);
  const boundedReason = reason ? truncateWithEllipsis(reason, reasonBudget) : "";
  const suffix = boundedReason ? `${separator}${boundedReason}` : "";

  const objectiveBudget = Math.max(0, MAX_BODY_LENGTH - prefix.length - suffix.length);
  const objective = truncateWithEllipsis(goal.objective, objectiveBudget);

  return truncateWithEllipsis(`${prefix}${objective}${suffix}`, MAX_BODY_LENGTH);
}

function resolveEventSessionId(event: SSEEvent): string | undefined {
  if (event.type === NotificationEventType.FORM_CREATED) {
    return event.data.form.sessionID;
  }
  return sessionIDFromEvent(event);
}

export function buildScheduleRunReportUrl(runId: number): string {
  return `/schedules?scheduleTab=runs&runId=${runId}`;
}

export function buildNotificationUrl(
  repo: Pick<Repo, "id"> | null,
  sessionId: string | undefined
): string {
  if (!repo) return "/";
  if (!sessionId) return `/repos/${repo.id}`;
  return buildSessionPath(repo.id, sessionId);
}

export function buildEventNotificationPayload(
  event: Pick<SSEEvent, "type" | "data">,
  context: {
    repoName?: string;
    repoId?: number;
    serverId?: string;
    serverName?: string;
    sessionId?: string;
    directory?: string;
    url: string;
  },
  locale: NotificationLocale = "en"
): PushNotificationPayload | null {
  const config = EVENT_CONFIG[event.type];
  if (!config) return null;

  const text = NOTIFICATION_TEXT[locale];
  const title = config.titleFn(event.data, text);

  const detail = config.bodyFn(event.data, text);
  const displayName = context.repoName ?? context.serverName;
  const rawBody = displayName
    ? `${displayName} · ${detail}`
    : detail;
  const body = truncateWithEllipsis(rawBody, MAX_BODY_LENGTH);

  return {
    title,
    body,
    tag: `${event.type}-${context.sessionId ?? "global"}`,
    timestamp: Date.now(),
    renotify: true,
    data: {
      eventType: event.type,
      sessionId: context.sessionId,
      directory: context.directory,
      repoId: context.repoId,
      repoName: context.repoName,
      serverId: context.serverId,
      serverName: context.serverName,
      url: context.url,
    },
  };
}

type EventSuppressor = (
  event: SSEEvent,
  sessionId: string | undefined,
  serverId: string
) => Promise<boolean>;

export class NotificationService {
  private vapidConfig: VapidConfig | null = null;
  private settingsService: SettingsService;
  private eventSuppressors: EventSuppressor[] = [];

  constructor(
    private db: Database,
    private serverRegistry: NotificationServerRegistry | null = null,
    private readonly telegram?: TelegramNotificationTransport | (() => TelegramNotificationTransport | undefined)
  ) {
    this.settingsService = new SettingsService(db);
    ensurePushSubscriptionsTable(db);
  }

  configureVapid(config: VapidConfig): void {
    this.vapidConfig = config;
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  getVapidPublicKey(): string | null {
    return this.vapidConfig?.publicKey ?? null;
  }

  addEventSuppressor(suppressor: EventSuppressor): void {
    this.eventSuppressors.push(suppressor);
  }

  isConfigured(): boolean {
    return this.vapidConfig !== null;
  }

  /** Reports whether any channel, Web Push or Telegram, can deliver a notification. */
  hasDeliveryChannel(): boolean {
    return this.isConfigured() || this.resolveTelegram() !== undefined;
  }

  /** Returns the current Telegram transport, treating unreadable stored settings as disabled. */
  private resolveTelegram(): TelegramNotificationTransport | undefined {
    try {
      return typeof this.telegram === "function" ? this.telegram() : this.telegram;
    } catch (error) {
      if (!(error instanceof TelegramSettingsStoreError)) throw error;
      logger.warn("Telegram settings are unavailable; delivery disabled");
      return undefined;
    }
  }

  /** Returns the locale of the shared Telegram channel, which follows the Manager's default user. */
  private operatorLocale(): NotificationLocale {
    return preferredLocale(this.settingsService.getSettings("default").preferences);
  }

  /** Sends a Telegram test message through the given transport without touching Web Push. */
  async sendTelegramTest(transport?: TelegramNotificationTransport): Promise<TelegramTestNotificationResponse> {
    if (!transport) return { ok: false, status: "not_configured" };
    const locale = this.operatorLocale();
    const ok = await transport.send(
      {
        title: NOTIFICATION_TEXT[locale].testTitle,
        body: NOTIFICATION_TEXT[locale].telegramTestBody,
        tag: "test",
        data: { eventType: "test", url: "/?settings=open&settingsTab=notifications" },
      },
      locale
    );
    return { ok, status: ok ? "sent" : "failed" };
  }

  /** Delivers one payload to the user's push subscriptions and to Telegram, combining the delivery counts. */
  async sendNotification(
    userId: string,
    payload: PushNotificationPayload
  ): Promise<{ delivered: number; expired: number; failed: number; total: number }> {
    const transport = this.resolveTelegram();
    const [push, telegram] = await Promise.all([
      this.isConfigured()
        ? this.sendToUser(userId, payload)
        : { delivered: 0, expired: 0, failed: 0, total: 0 },
      transport?.send(payload, this.operatorLocale()),
    ]);
    return {
      delivered: push.delivered + (telegram === true ? 1 : 0),
      expired: push.expired,
      failed: push.failed + (telegram === false ? 1 : 0),
      total: push.total + (transport ? 1 : 0),
    };
  }

  /**
   * Stores a device's push subscription, returning null when the session that registered it was
   * revoked or expired before the write. The session check and the upsert share one synchronous
   * transaction so a concurrent logout cannot land between them.
   */
  saveSubscription(
    userId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
    deviceName?: string,
    sessionId?: string | null
  ): PushSubscriptionRecord | null {
    return this.db.transaction(() => {
      if (sessionId && !isAuthSessionActive(this.db, sessionId)) return null;
      return this.writeSubscription(userId, endpoint, p256dh, auth, deviceName, sessionId);
    })();
  }

  private writeSubscription(
    userId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
    deviceName?: string,
    sessionId?: string | null
  ): PushSubscriptionRecord {
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_name, session_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           device_name = COALESCE(excluded.device_name, push_subscriptions.device_name),
           session_id = excluded.session_id,
           last_used_at = excluded.last_used_at`
      )
      .run(userId, endpoint, p256dh, auth, deviceName ?? null, sessionId ?? null, now, now);

    const row = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(endpoint) as {
      id: number;
      user_id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      device_name: string | null;
      session_id: string | null;
      created_at: number;
      last_used_at: number | null;
    };

    return {
      id: row.id,
      userId: row.user_id,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      deviceName: row.device_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  removeSubscription(endpoint: string, userId?: string): boolean {
    if (userId) {
      const result = this.db
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .run(endpoint, userId);
      return result.changes > 0;
    }
    const result = this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint);
    return result.changes > 0;
  }

  removeSubscriptionById(id: number, userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return result.changes > 0;
  }

  getSubscriptions(userId: string): PushSubscriptionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<{
      id: number;
      user_id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      device_name: string | null;
      created_at: number;
      last_used_at: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      deviceName: row.device_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  getAllUserIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT user_id FROM push_subscriptions")
      .all() as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  /** Returns the run report URL when the session was started by a scheduled run. */
  getScheduleRunReportUrl(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const run = getScheduleRunBySessionId(this.db, sessionId);
    return run ? buildScheduleRunReportUrl(run.id) : null;
  }

  /** Delivers a notification in each recipient's locale: every subscriber's own, and the operator's for Telegram. */
  private async deliverToSubscribers(
    payloadFor: (locale: NotificationLocale) => PushNotificationPayload | null,
    shouldNotify: (preferences: NotificationPreferences) => boolean
  ): Promise<void> {
    const payloads: Record<NotificationLocale, PushNotificationPayload | null> = {
      ko: payloadFor("ko"),
      en: payloadFor("en"),
    };
    const operatorLocale = this.operatorLocale();
    const telegramPayload = payloads[operatorLocale];
    const telegramDelivery = telegramPayload
      ? this.resolveTelegram()?.send(telegramPayload, operatorLocale)
      : undefined;

    if (this.isConfigured()) {
      for (const userId of this.getAllUserIds()) {
        const settings = this.settingsService.getSettings(userId);
        const notifPrefs =
          settings.preferences.notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;

        if (!shouldNotify(notifPrefs)) continue;

        const payload = payloads[preferredLocale(settings.preferences)];
        if (payload) await this.sendToUser(userId, payload);
      }
    }

    await telegramDelivery;
  }

  async handleSSEEvent(
    directory: string | null,
    event: SSEEvent,
    serverId: string = LOCAL_OPENCODE_SERVER_ID
  ): Promise<void> {
    const config = EVENT_CONFIG[event.type];
    if (!config) return;

    const sessionId = resolveEventSessionId(event);
    if (sessionId && sseAggregator.isSessionBeingViewed(sessionId, serverId)) return;
    if (sessionId && sseAggregator.isSubagentSession(sessionId, serverId)) return;

    for (const suppressor of this.eventSuppressors) {
      if (await suppressor(event, sessionId, serverId)) return;
    }

    if (serverId !== LOCAL_OPENCODE_SERVER_ID) {
      await this.deliverRemoteEvent(
        serverId,
        directory,
        event,
        sessionId,
        config.preferencesKey
      );
      return;
    }

    const repo = directory ? await resolveRepoForDirectory(this.db, directory) : null;
    const repoId = repo?.id;
    const repoName = repo ? getRepoName(repo) : undefined;
    const reportUrl = RUN_OUTCOME_EVENTS.has(event.type) ? this.getScheduleRunReportUrl(sessionId) : null;
    const url = reportUrl ?? buildNotificationUrl(repo, sessionId);

    const context = {
      repoName,
      repoId,
      sessionId,
      directory: directory ?? undefined,
      url,
    };

    await this.deliverToSubscribers(
      (locale) => buildEventNotificationPayload(event, context, locale),
      (preferences) =>
        preferences.enabled &&
        preferences.events[config.preferencesKey] === true
    );
  }

  private async deliverRemoteEvent(
    serverId: string,
    directory: string | null,
    event: SSEEvent,
    sessionId: string | undefined,
    preferencesKey: keyof typeof DEFAULT_NOTIFICATION_PREFERENCES.events
  ): Promise<void> {
    const server = this.serverRegistry?.get(serverId) ?? null;
    if (!server || !server.enabled) return;

    const url = sessionId
      ? buildServerSessionPath(serverId, sessionId)
      : `/servers/${encodeURIComponent(serverId)}`;

    const context = {
      serverId,
      serverName: server.name,
      sessionId,
      directory: directory ?? undefined,
      url,
    };

    await this.deliverToSubscribers(
      (locale) => buildEventNotificationPayload(event, context, locale),
      (preferences) =>
        preferences.enabled &&
        preferences.events[preferencesKey] === true
    );
  }

  async notifyGoalOutcome(goal: SessionGoal): Promise<void> {
    if (goal.stopReason === "turn_error") return;
    if (goal.stopReason === "cancelled" || goal.stopReason === "user_paused") return;
    if (sseAggregator.isSessionBeingViewed(goal.sessionId, goal.serverId)) return;

    const isRemote = goal.serverId !== LOCAL_OPENCODE_SERVER_ID;
    const repo = !isRemote && goal.directory
      ? await resolveRepoForDirectory(this.db, goal.directory)
      : null;
    const server = isRemote ? this.serverRegistry?.get(goal.serverId) ?? null : null;
    const repoName = repo ? getRepoName(repo) : undefined;
    const displayName = repoName ?? server?.name;

    const payloadFor = (locale: NotificationLocale): PushNotificationPayload => ({
      title: NOTIFICATION_TEXT[locale].goalTitle(goal.status),
      body: buildGoalOutcomeBody(goal, displayName, NOTIFICATION_TEXT[locale]),
      tag: `session-goal-${goal.id}`,
      timestamp: Date.now(),
      renotify: true,
      data: {
        eventType: "session.goal.outcome",
        sessionId: goal.sessionId,
        directory: goal.directory,
        repoId: repo?.id,
        repoName,
        serverId: goal.serverId,
        serverName: server?.name,
        url: isRemote
          ? buildServerSessionPath(goal.serverId, goal.sessionId)
          : buildNotificationUrl(repo, goal.sessionId),
      },
    });

    await this.deliverToSubscribers(
      payloadFor,
      (preferences) =>
        preferences.enabled && preferences.events.goalOutcome !== false
    );
  }

  async sendTestNotification(userId: string): Promise<void> {
    const text = NOTIFICATION_TEXT[preferredLocale(this.settingsService.getSettings(userId).preferences)];
    await this.sendToUser(userId, {
      title: text.testTitle,
      body: text.pushTestBody,
      tag: "test",
      data: { eventType: "test", url: "/" },
    });
  }

  async sendToUser(
    userId: string,
    payload: PushNotificationPayload
  ): Promise<{ delivered: number; expired: number; failed: number; total: number }> {
    const subscriptions = this.getSubscriptions(userId);
    const expiredEndpoints: string[] = [];
    let delivered = 0
    let failed = 0

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify(payload)
          );

          this.db
            .prepare(
              "UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?"
            )
            .run(Date.now(), sub.id);
          
          delivered++
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;

          if (statusCode === 404 || statusCode === 410) {
            expiredEndpoints.push(sub.endpoint);
          } else {
            logger.error(`Push delivery failed for ${sub.endpoint.slice(0, 50)}:`, error);
            failed++
          }
        }
      })
    );

    for (const endpoint of expiredEndpoints) {
      this.removeSubscription(endpoint);
    }

    return {
      delivered,
      expired: expiredEndpoints.length,
      failed,
      total: subscriptions.length,
    }
  }
}
