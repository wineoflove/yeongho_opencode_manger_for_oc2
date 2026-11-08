import { useNotifications } from "@/hooks/useNotifications";
import { Loader2, BellOff, Trash2, Send, Monitor } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { showToast } from "@/lib/toast";
import { TelegramNotificationSettings } from "./TelegramNotificationSettings";
import { formatRelativeTime } from "@/i18n/format";
import { t } from "@/i18n/translate";

export function NotificationSettings() {
  return (
    <>
      <PushNotificationSettings />
      <div className="mt-6 w-full max-w-7xl">
        <TelegramNotificationSettings />
      </div>
    </>
  );
}

function PushNotificationSettings() {
  const {
    isSupported,
    isAvailable,
    permission,
    isEnabled,
    preferences,
    subscriptions,
    isLoadingSubscriptions,
    enable,
    disable,
    updateEventPreference,
    removeDevice,
    sendTest,
    isSubscribing,
    isTesting,
  } = useNotifications();

  if (!isSupported) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 break-keep">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          {t("Push Notifications")}
        </h2>
        <div className="flex items-center gap-3 text-muted-foreground">
          <BellOff className="h-5 w-5" />
          <p className="text-sm">
            {t("Push notifications are not supported in this browser.")}
          </p>
        </div>
      </div>
    );
  }

  if (!isAvailable) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 break-keep">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          {t("Push Notifications")}
        </h2>
        <div className="flex items-center gap-3 text-muted-foreground">
          <BellOff className="h-5 w-5" />
          <p className="text-sm">
            {t("Push notifications are not configured on the server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables to enable.")}
          </p>
        </div>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="bg-card border border-border rounded-lg p-6 break-keep">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          {t("Push Notifications")}
        </h2>
        <div className="flex items-center gap-3 text-warning">
          <BellOff className="h-5 w-5" />
          <p className="text-sm">
            {t("Notification permission was denied. Please enable notifications in your browser settings for this site.")}
          </p>
        </div>
      </div>
    );
  }

  const handleEnable = async () => {
    try {
      await enable();
      showToast.success(t("Push notifications enabled"));
    } catch {
      showToast.error(t("Failed to enable push notifications"));
    }
  };

  const handleDisable = async () => {
    try {
      await disable();
      showToast.success(t("Push notifications disabled"));
    } catch {
      showToast.error(t("Failed to disable push notifications"));
    }
  };

  const handleTest = () => {
    sendTest(undefined, {
      onSuccess: (data) => {
        showToast.success(
          t("Test notification sent to {count} device(s)", { count: data.devicesNotified })
        );
      },
      onError: () => {
        showToast.error(t("Failed to send test notification"));
      },
    });
  };

  return (
    <div className="@container w-full max-w-7xl space-y-6 break-keep">
      <div className="grid gap-6 @min-[1000px]:grid-cols-[2fr_1fr] @min-[1000px]:items-start">
        <div className="min-w-0 bg-card border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-6">
            {t("Push Notifications")}
          </h2>

          <div className="space-y-6">
            <div className="divide-y divide-border">
              <div className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor="notificationsEnabled" className="text-base">
                    {t("Enable push notifications")}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("Receive notifications when the app is in the background")}
                  </p>
                </div>
                <Switch
                  id="notificationsEnabled"
                  checked={isEnabled}
                  disabled={isSubscribing}
                  onCheckedChange={(checked) =>
                    checked ? handleEnable() : handleDisable()
                  }
                />
              </div>

              {isEnabled && (
                <>
                  <div className="py-3">
                    <h3 className="text-sm font-medium text-foreground">
                      {t("Notification Events")}
                    </h3>
                  </div>

                  <div className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor="notifPermission" className="text-base">
                        {t("Permission requests")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("When the agent needs approval to proceed")}
                      </p>
                    </div>
                    <Switch
                      id="notifPermission"
                      checked={preferences.events.permissionAsked}
                      onCheckedChange={(checked) =>
                        updateEventPreference("permissionAsked", checked)
                      }
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor="notifQuestion" className="text-base">
                        {t("Agent questions")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("When the agent has a question for you")}
                      </p>
                    </div>
                    <Switch
                      id="notifQuestion"
                      checked={preferences.events.questionAsked}
                      onCheckedChange={(checked) =>
                        updateEventPreference("questionAsked", checked)
                      }
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor="notifError" className="text-base">
                        {t("Session errors")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("When a session encounters an error")}
                      </p>
                    </div>
                    <Switch
                      id="notifError"
                      checked={preferences.events.sessionError}
                      onCheckedChange={(checked) =>
                        updateEventPreference("sessionError", checked)
                      }
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor="notifIdle" className="text-base">
                        {t("Session completion")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("When a session finishes processing")}
                      </p>
                    </div>
                    <Switch
                      id="notifIdle"
                      checked={preferences.events.sessionIdle}
                      onCheckedChange={(checked) =>
                        updateEventPreference("sessionIdle", checked)
                      }
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor="notifGoalOutcome" className="text-base">
                        {t("Goal outcomes")}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t("When a session goal completes, blocks or stops")}
                      </p>
                    </div>
                    <Switch
                      id="notifGoalOutcome"
                      checked={preferences.events.goalOutcome ?? true}
                      onCheckedChange={(checked) =>
                        updateEventPreference("goalOutcome", checked)
                      }
                    />
                  </div>
                </>
              )}
            </div>

            {isEnabled && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={isTesting || subscriptions.length === 0}
                >
                  {isTesting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Send className="h-4 w-4 mr-2" />
                  )}
                  {t("Send test notification")}
                </Button>
              </div>
            )}
          </div>
        </div>

        {isEnabled && (
          <div className="min-w-0 bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">
              {t("Registered Devices")}
            </h2>

            {isLoadingSubscriptions ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : subscriptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("No devices registered for push notifications.")}
              </p>
            ) : (
              <div className="space-y-3">
                {subscriptions.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Monitor className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {sub.deviceName ?? (sub.endpoint.length > 60 ? sub.endpoint.slice(0, 60) + "..." : sub.endpoint)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {sub.lastUsedAt
                            ? t("Last used {time}", { time: formatRelativeTime(sub.lastUsedAt) })
                            : t("Added {time}", { time: formatRelativeTime(sub.createdAt) })}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive flex-shrink-0"
                      onClick={() => removeDevice(sub.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
