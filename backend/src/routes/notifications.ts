import { Hono } from "hono";
import { z } from "zod";
import { PushSubscriptionRequestSchema, UpdateTelegramSettingsRequestSchema } from "@opencode-manager/shared/schemas";
import type { NotificationService } from "../services/notification";
import { TelegramSettingsValidationError, type TelegramSettingsService } from "../services/telegram-settings";
import type { Session } from "../auth";

interface NotificationRouteVariables {
  session?: Session['session'];
}

export function createNotificationRoutes(
  notificationService: NotificationService,
  telegramSettings?: TelegramSettingsService
) {
  const app = new Hono<{ Variables: NotificationRouteVariables }>();

  app.get("/telegram", (c) => {
    try {
      if (!telegramSettings) return c.json({ error: "Telegram settings are unavailable" }, 500);
      return c.json(telegramSettings.getSettings());
    } catch {
      return c.json({ error: "Telegram settings are unavailable" }, 500);
    }
  });

  app.put("/telegram", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = UpdateTelegramSettingsRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid Telegram settings" }, 400);
    try {
      if (!telegramSettings) return c.json({ error: "Telegram settings are unavailable" }, 500);
      return c.json(telegramSettings.updateSettings(parsed.data));
    } catch (error) {
      if (error instanceof TelegramSettingsValidationError) return c.json({ error: "Invalid Telegram settings" }, 400);
      return c.json({ error: "Telegram settings are unavailable" }, 500);
    }
  });

  app.post("/telegram/test", async (c) => {
    try {
      if (!telegramSettings) return c.json({ error: "Telegram settings are unavailable" }, 500);
      return c.json(await notificationService.sendTelegramTest(telegramSettings.getTransport()));
    } catch {
      return c.json({ error: "Telegram settings are unavailable" }, 500);
    }
  });

  app.get("/vapid-public-key", (c) => {
    const publicKey = notificationService.getVapidPublicKey();
    if (!publicKey) {
      return c.json(
        { error: "Push notifications are not configured" },
        503
      );
    }
    return c.json({ publicKey });
  });

  app.post("/subscribe", async (c) => {
    const userId = c.req.query('userId') || 'default'
    const sessionId = c.get('session')?.id
    const body = await c.req.json();
    const parsed = PushSubscriptionRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid subscription data", details: parsed.error.issues }, 400);
    }

    const { endpoint, keys, deviceName } = parsed.data;

    const subscription = notificationService.saveSubscription(
      userId,
      endpoint,
      keys.p256dh,
      keys.auth,
      deviceName,
      sessionId
    );

    if (!subscription) {
      return c.json({ error: "Session is no longer valid" }, 401);
    }

    return c.json({ subscription });
  });

  app.delete("/subscribe", async (c) => {
    const userId = c.req.query('userId') || 'default'
    const body = await c.req.json();
    const parsed = z.object({ endpoint: z.string().url() }).safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Valid endpoint URL is required", details: parsed.error.issues }, 400);
    }

    const removed = notificationService.removeSubscription(parsed.data.endpoint, userId);
    return c.json({ success: removed });
  });

  app.get("/subscriptions", (c) => {
    const userId = c.req.query('userId') || 'default'
    const subscriptions = notificationService.getSubscriptions(userId);
    return c.json({ subscriptions });
  });

  app.delete("/subscriptions/:id", (c) => {
    const userId = c.req.query('userId') || 'default'
    const id = parseInt(c.req.param("id"), 10);

    if (isNaN(id)) {
      return c.json({ error: "Invalid subscription ID" }, 400);
    }

    const removed = notificationService.removeSubscriptionById(id, userId);
    return c.json({ success: removed });
  });

  app.post("/test", async (c) => {
    const userId = c.req.query('userId') || 'default'

    if (!notificationService.isConfigured()) {
      return c.json(
        { error: "Push notifications are not configured" },
        503
      );
    }

    const subscriptions = notificationService.getSubscriptions(userId);
    if (subscriptions.length === 0) {
      return c.json(
        { error: "No push subscriptions registered" },
        404
      );
    }

    await notificationService.sendTestNotification(userId);

    return c.json({ success: true, devicesNotified: subscriptions.length });
  });

  return app;
}
