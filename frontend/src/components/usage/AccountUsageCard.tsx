import type {
  AccountUsage,
  AccountUsageState,
  UsageConfidence,
} from "@opencode-manager/shared/schemas";
import { formatDatePattern, formatRelativeTime } from "@/i18n/format";
import { t } from "@/i18n/translate";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageWindowRow } from "@/components/usage/UsageWindowRow";
import { displayUsageWindows, formatResetAbsolute } from "@/lib/usageFormat";

type StateBadge = {
  readonly variant: "default" | "secondary" | "destructive" | "outline";
  readonly label: string;
  readonly className?: string;
};

function assertNever(value: never): never {
  throw new Error(
    t("Unhandled account usage value: {value}", { value: String(value) }),
  );
}

function stateBadge(state: AccountUsageState): StateBadge {
  switch (state) {
    case "ok":
      return {
        variant: "outline",
        label: t("Active"),
        className:
          "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400",
      };
    case "rate-limited":
      return { variant: "destructive", label: t("Rate limited") };
    case "auth-invalid":
      return { variant: "destructive", label: t("Re-login required") };
    case "disabled":
      return { variant: "secondary", label: t("Disabled") };
    case "awaiting-first-request":
      return {
        variant: "secondary",
        label: t("No data yet — updates after the next request"),
      };
    default:
      return assertNever(state);
  }
}

function confidenceLabel(confidence: UsageConfidence): string | undefined {
  switch (confidence) {
    case "fresh":
      return undefined;
    case "stale":
      return t("Stale");
    case "error":
      return t("Usage lookup failed");
    case "unknown":
      return t("Unknown");
    default:
      return assertNever(confidence);
  }
}

/** One account's last observed subscription windows, as CLIProxy saw them on its most recent response. */
export function AccountUsageCard({
  account,
}: {
  readonly account: AccountUsage;
}) {
  const state = stateBadge(account.state);
  const confidence = confidenceLabel(account.confidence);
  const historical = account.confidence !== "fresh";
  const windows = displayUsageWindows(account);

  return (
    <Card data-testid="account-usage-card">
      <CardHeader className="space-y-2 p-4 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{account.label}</CardTitle>
            {account.email && account.email !== account.label ? (
              <p className="truncate text-xs text-muted-foreground">
                {account.email}
              </p>
            ) : null}
          </div>
          {account.planType ? (
            <Badge variant="secondary">{account.planType}</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={state.variant} className={state.className}>
            {state.label}
          </Badge>
          {confidence ? <Badge variant="outline">{confidence}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        {account.rateLimitedUntil !== undefined && (
          <p className="text-xs text-destructive">
            {t("Paused until {date}", {
              date: formatResetAbsolute(account.rateLimitedUntil),
            })}
          </p>
        )}
        {historical && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {windows.length > 0 ? (
              <>
                <p className="font-medium text-foreground">
                  {t("Last known usage")}
                </p>
                <p>
                  {t(
                    "These are previously observed values. Current remaining quota is unknown.",
                  )}
                </p>
              </>
            ) : (
              <p>{t("Current usage is unavailable.")}</p>
            )}
          </div>
        )}
        {windows.map((usageWindow) => (
          <UsageWindowRow
            key={usageWindow.key}
            window={usageWindow}
            historical={historical}
          />
        ))}
        {account.updatedAt !== undefined ? (
          <div className="text-xs text-muted-foreground">
            <p>{t("Last observed usage")}</p>
            <time dateTime={new Date(account.updatedAt).toISOString()}>
              {formatDatePattern(
                account.updatedAt,
                "yyyy-MM-dd HH:mm:ss xxx",
                "yyyy-MM-dd HH:mm:ss xxx",
              )}{" "}
              · {formatRelativeTime(account.updatedAt)}
            </time>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
