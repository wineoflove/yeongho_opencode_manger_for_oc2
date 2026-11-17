import { describe, expect, it } from "vitest";
import { AccountUsageResponseSchema } from "@opencode-manager/shared/schemas";
import { toAccountUsageResponse } from "../../src/services/cliproxy-account-usage";
import type { ClaudeProxyUsageSource } from "../../src/services/claude-proxy-usage-sources";

const now = Date.parse("2026-11-17T03:00:00Z");
const observedAt = "2026-11-17T02:00:00Z";
const observedMs = Date.parse(observedAt);

function source(
  fields: Partial<ClaudeProxyUsageSource>,
): ClaudeProxyUsageSource {
  return {
    id: "aa47ac1b75dc0765",
    provider: "claude",
    label: "user@example.test",
    accountType: "oauth",
    enabled: true,
    unavailable: false,
    quotaBlocked: false,
    renewalState: "renewal_verified",
    successCount: 1,
    failureCount: 0,
    nextRetryAt: null,
    quota: { observedAt: null, signals: {} },
    cooldowns: [],
    ...fields,
  };
}

function usage(accounts: readonly ClaudeProxyUsageSource[]) {
  return AccountUsageResponseSchema.parse(
    toAccountUsageResponse({ observedAt: observedAt, accounts }, now),
  );
}

describe("CLIProxy quota to account usage", () => {
  it("maps Claude unified windows from the passive quota snapshot", () => {
    const result = usage([
      source({
        quota: {
          observedAt,
          signals: {
            "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
            "Anthropic-Ratelimit-Unified-5h-Reset": "1794891600",
            "Anthropic-Ratelimit-Unified-7d-Utilization": "0.071",
            "Anthropic-Ratelimit-Unified-7d-Reset": "1795300000",
            "Anthropic-Ratelimit-Unified-7d_oi-Utilization": "0.9",
          },
        },
      }),
    ]);
    const anthropic = result.sources.find(
      (entry) => entry.provider === "anthropic",
    );
    expect(anthropic?.status).toBe("ok");
    const [account] = anthropic?.accounts ?? [];
    expect(account).toMatchObject({
      accountKey: "aa47ac1b75dc0765",
      label: "user@example.test",
      email: "user@example.test",
      enabled: true,
      state: "ok",
      confidence: "fresh",
      updatedAt: observedMs,
    });
    expect(account?.windows).toEqual([
      {
        key: "five_hour",
        label: "5 hours",
        usedPercent: 42,
        resetAt: 1794891600000,
        updatedAt: observedMs,
      },
      {
        key: "seven_day",
        label: "7 days",
        usedPercent: 7,
        resetAt: 1795300000000,
        updatedAt: observedMs,
      },
      {
        key: "seven_day_fable",
        label: "Fable only · 7 days",
        usedPercent: 90,
        updatedAt: observedMs,
      },
    ]);
  });

  it("maps Codex windows by their minutes and resolves relative resets from the observation time", () => {
    const result = usage([
      source({
        id: "bb47ac1b75dc0765",
        provider: "openai",
        label: null,
        quota: {
          observedAt,
          signals: {
            "X-Codex-Primary-Used-Percent": "12.5",
            "X-Codex-Primary-Window-Minutes": "300",
            "X-Codex-Primary-Reset-After-Seconds": "600",
            "X-Codex-Secondary-Used-Percent": "61",
            "X-Codex-Secondary-Window-Minutes": "10080",
            "X-Codex-Secondary-Reset-At": "1795300000",
          },
        },
      }),
    ]);
    const [account] =
      result.sources.find((entry) => entry.provider === "openai")?.accounts ??
      [];
    expect(account?.label).toBe("OpenAI account bb47ac1b75dc0765");
    expect(account?.email).toBeUndefined();
    expect(account?.windows).toEqual([
      {
        key: "five_hour",
        label: "5 hours",
        usedPercent: 13,
        resetAt: observedMs + 600_000,
        updatedAt: observedMs,
      },
      {
        key: "weekly",
        label: "Weekly",
        usedPercent: 61,
        resetAt: 1795300000000,
        updatedAt: observedMs,
      },
    ]);
  });

  it("labels a single seven-day Codex primary window as weekly", () => {
    const [account] =
      usage([
        source({
          provider: "openai",
          quota: {
            observedAt,
            signals: {
              "X-Codex-Primary-Used-Percent": "5",
              "X-Codex-Primary-Window-Minutes": "10080",
            },
          },
        }),
      ]).sources.find((entry) => entry.provider === "openai")?.accounts ?? [];
    expect(account?.windows).toEqual([
      { key: "weekly", label: "Weekly", usedPercent: 5, updatedAt: observedMs },
    ]);
  });

  it.each<[string, Partial<ClaudeProxyUsageSource>, string, string]>([
    [
      "disabled wins",
      { enabled: false, quotaBlocked: true },
      "disabled",
      "fresh",
    ],
    [
      "sign-in required",
      { renewalState: "expired_sign_in_required" },
      "auth-invalid",
      "fresh",
    ],
    [
      "active cooldown",
      {
        cooldowns: [
          {
            scope: "credential",
            reason: "quota",
            retryAt: "2026-11-17T04:00:00Z",
            remainingSeconds: 3600,
          },
        ],
      },
      "rate-limited",
      "fresh",
    ],
    ["runtime quota block", { quotaBlocked: true }, "rate-limited", "fresh"],
  ])("derives the state when %s", (_name, fields, state, confidence) => {
    const [account] =
      usage([
        source({
          quota: {
            observedAt,
            signals: { "Anthropic-Ratelimit-Unified-5h-Utilization": "0.1" },
          },
          ...fields,
        }),
      ]).sources[0]?.accounts ?? [];
    expect(account?.state).toBe(state);
    expect(account?.confidence).toBe(confidence);
  });

  it("reports the cooldown end as the rate limit end", () => {
    const [account] =
      usage([
        source({
          cooldowns: [
            {
              scope: "model",
              reason: "quota",
              retryAt: "2026-11-17T03:30:00Z",
              remainingSeconds: 1800,
            },
            {
              scope: "credential",
              reason: "quota",
              retryAt: "2026-11-17T04:00:00Z",
              remainingSeconds: 3600,
            },
          ],
        }),
      ]).sources[0]?.accounts ?? [];
    expect(account?.rateLimitedUntil).toBe(Date.parse("2026-11-17T04:00:00Z"));
  });

  it("marks accounts without any observation as awaiting their first request", () => {
    const [account] = usage([source({})]).sources[0]?.accounts ?? [];
    expect(account).toMatchObject({
      state: "awaiting-first-request",
      confidence: "unknown",
      windows: [],
    });
    expect(account?.updatedAt).toBeUndefined();
  });

  it("marks observations older than six hours as stale", () => {
    const [account] =
      usage([
        source({
          quota: {
            observedAt: "2026-11-16T20:00:00Z",
            signals: { "Anthropic-Ratelimit-Unified-5h-Utilization": "0.1" },
          },
        }),
      ]).sources[0]?.accounts ?? [];
    expect(account?.confidence).toBe("stale");
  });

  it("treats a rejected window that has not reset yet as rate limited", () => {
    const [account] =
      usage([
        source({
          quota: {
            observedAt,
            signals: {
              "Anthropic-Ratelimit-Unified-5h-Utilization": "1",
              "Anthropic-Ratelimit-Unified-5h-Reset": "1794891600",
              "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
            },
          },
        }),
      ]).sources[0]?.accounts ?? [];
    expect(account?.state).toBe("rate-limited");
  });

  it("keeps both providers present even without accounts", () => {
    expect(
      usage([]).sources.map((entry) => [entry.provider, entry.accounts.length]),
    ).toEqual([
      ["anthropic", 0],
      ["openai", 0],
    ]);
  });
});
