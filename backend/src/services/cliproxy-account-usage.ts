import type {
  AccountUsage,
  AccountUsageResponse,
  AccountUsageState,
  UsageWindow,
} from "@opencode-manager/shared/schemas";
import type { ClaudeProxyUsageSource } from "./claude-proxy-usage-sources";
import { parseAnthropicRateLimits } from "./provider-rate-limits";

const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const SIGN_IN_STATES = new Set([
  "expired_sign_in_required",
  "sign_in_required",
]);
const ANTHROPIC_WINDOWS = {
  five_hour: { key: "five_hour", label: "5 hours" },
  seven_day: { key: "seven_day", label: "7 days" },
  seven_day_overage_included: {
    key: "seven_day_fable",
    label: "Fable only · 7 days",
  },
} as const;

function parseTime(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    const ms = seconds > 1e12 ? seconds : seconds * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(raw: string | null): number | undefined {
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  return Math.min(100, Math.max(0, Math.round(Number(raw.trim()))));
}

function anthropicWindows(
  headers: Headers,
  observedMs: number,
): { readonly windows: UsageWindow[]; readonly rejectedUntil?: number } {
  const parsed = parseAnthropicRateLimits(headers, observedMs);
  const windows: UsageWindow[] = [];
  let rejectedUntil: number | undefined;
  for (const window of parsed.subscriptionWindows) {
    const target = ANTHROPIC_WINDOWS[window.window];
    windows.push({
      key: target.key,
      label: target.label,
      ...(window.usedPercent === null
        ? {}
        : { usedPercent: window.usedPercent }),
      ...(window.resetAt === null ? {} : { resetAt: window.resetAt }),
      updatedAt: observedMs,
    });
    if (
      window.window !== "seven_day_overage_included" &&
      window.status === "rejected" &&
      window.resetAt !== null
    )
      rejectedUntil = Math.max(rejectedUntil ?? 0, window.resetAt);
  }
  return {
    windows,
    ...(rejectedUntil === undefined ? {} : { rejectedUntil }),
  };
}

function codexWindows(headers: Headers, observedMs: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const slot of ["Primary", "Secondary"] as const) {
    const prefix = `x-codex-${slot.toLowerCase()}`;
    const usedPercent = parsePercent(headers.get(`${prefix}-used-percent`));
    const minutes = Number(headers.get(`${prefix}-window-minutes`) ?? NaN);
    if (Number.isFinite(minutes) && minutes <= 0) continue;
    const after = Number(headers.get(`${prefix}-reset-after-seconds`) ?? NaN);
    const resetAt =
      parseTime(headers.get(`${prefix}-reset-at`)) ??
      (Number.isFinite(after) && after >= 0
        ? observedMs + Math.round(after * 1000)
        : undefined);
    if (usedPercent === undefined && resetAt === undefined) continue;
    const weekly = Number.isFinite(minutes)
      ? minutes > 300
      : slot === "Secondary";
    windows.push({
      key: weekly ? "weekly" : "five_hour",
      label: weekly ? "Weekly" : "5 hours",
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetAt === undefined ? {} : { resetAt }),
      updatedAt: observedMs,
    });
  }
  return windows;
}

function toAccountUsage(
  source: ClaudeProxyUsageSource,
  now: number,
): AccountUsage {
  const observedMs =
    source.quota.observedAt === null
      ? undefined
      : Date.parse(source.quota.observedAt);
  const headers = new Headers(source.quota.signals);
  const anthropic =
    source.provider === "claude" && observedMs !== undefined
      ? anthropicWindows(headers, observedMs)
      : { windows: [] };
  const windows =
    source.provider === "openai" && observedMs !== undefined
      ? codexWindows(headers, observedMs)
      : anthropic.windows;
  const cooldownEnds = source.cooldowns
    .map((cooldown) => Date.parse(cooldown.retryAt))
    .filter((end) => Number.isFinite(end) && end > now);
  const rejectedUntil =
    "rejectedUntil" in anthropic && anthropic.rejectedUntil !== undefined
      ? anthropic.rejectedUntil
      : undefined;
  const limitEnds = [
    ...cooldownEnds,
    ...(rejectedUntil !== undefined && rejectedUntil > now
      ? [rejectedUntil]
      : []),
  ];
  const state: AccountUsageState = !source.enabled
    ? "disabled"
    : source.renewalState !== null && SIGN_IN_STATES.has(source.renewalState)
      ? "auth-invalid"
      : limitEnds.length > 0 || source.quotaBlocked
        ? "rate-limited"
        : observedMs === undefined
          ? "awaiting-first-request"
          : "ok";
  const label =
    source.label ??
    `${source.provider === "claude" ? "Claude" : "OpenAI"} account ${source.id}`;
  return {
    provider: source.provider === "claude" ? "anthropic" : "openai",
    accountKey: source.id,
    label,
    ...(source.label?.includes("@") ? { email: source.label } : {}),
    enabled: source.enabled,
    state,
    confidence:
      observedMs === undefined
        ? "unknown"
        : now - observedMs <= FRESH_WINDOW_MS
          ? "fresh"
          : "stale",
    windows,
    ...(limitEnds.length > 0
      ? { rateLimitedUntil: Math.max(...limitEnds) }
      : {}),
    ...(observedMs === undefined ? {} : { updatedAt: observedMs }),
  };
}

/** Builds the account usage view from CLIProxyAPI's passive quota snapshots; nothing is fetched upstream. */
export function toAccountUsageResponse(
  data: {
    readonly observedAt: string;
    readonly accounts: readonly ClaudeProxyUsageSource[];
  },
  now: number,
): AccountUsageResponse {
  const accounts = data.accounts.map((source) => toAccountUsage(source, now));
  return {
    generatedAt: now,
    sources: (["anthropic", "openai"] as const).map((provider) => ({
      provider,
      status: "ok",
      accounts: accounts.filter((account) => account.provider === provider),
    })),
  };
}
