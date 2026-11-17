import type { z } from "zod";
import type { usageCredentialFieldsSchema } from "./claude-proxy-usage-contract";

/** Quota and runtime state of one account, without credential material. */
export type ClaudeProxyUsageSource = {
  readonly id: string;
  readonly provider: "claude" | "openai";
  readonly label: string | null;
  readonly accountType: string | null;
  readonly enabled: boolean;
  readonly unavailable: boolean;
  readonly quotaBlocked: boolean;
  readonly renewalState: string | null;
  readonly successCount: number;
  readonly failureCount: number;
  readonly nextRetryAt: string | null;
  readonly quota: {
    readonly observedAt: string | null;
    readonly signals: Readonly<Record<string, string>>;
  };
  readonly cooldowns: readonly {
    readonly scope: string;
    readonly modelKey?: string;
    readonly reason: string;
    readonly retryAt: string;
    readonly remainingSeconds: number;
    readonly httpStatus?: number;
  }[];
};


type UsageCredential = z.infer<typeof usageCredentialFieldsSchema> & {
  readonly auth_index: string;
  readonly provider: string;
  readonly email?: string;
  readonly label?: string;
  readonly disabled: boolean;
  readonly unavailable: boolean;
  readonly success: number;
  readonly failed: number;
  readonly next_retry_after?: string;
};

/** Maps credential entries to usage sources, dropping every credential-bearing field. */
export function toUsageSources(data: {
  readonly observedAt: string;
  readonly files: readonly UsageCredential[];
}): {
  readonly observedAt: string;
  readonly accounts: readonly ClaudeProxyUsageSource[];
} {
  return {
    observedAt: data.observedAt,
    accounts: data.files.map((entry) => ({
      id: entry.auth_index,
      provider: entry.provider === "claude" ? "claude" : "openai",
      label: entry.email?.trim() || entry.label?.trim() || null,
      accountType: entry.account_type ?? null,
      enabled: !entry.disabled,
      unavailable: entry.unavailable,
      quotaBlocked: entry.quota_blocked ?? false,
      renewalState: entry.renewal_state ?? null,
      successCount: entry.success,
      failureCount: entry.failed,
      nextRetryAt: entry.next_retry_after ?? null,
      quota: {
        observedAt: entry.quota?.observed_at ?? null,
        signals: entry.quota?.signals ?? {},
      },
      cooldowns: (entry.cooldowns ?? []).map((cooldown) => ({
        scope: cooldown.scope,
        ...(cooldown.model_key === undefined
          ? {}
          : { modelKey: cooldown.model_key }),
        reason: cooldown.reason,
        retryAt: cooldown.retry_at,
        remainingSeconds: cooldown.remaining_seconds,
        ...(cooldown.http_status === undefined
          ? {}
          : { httpStatus: cooldown.http_status }),
      })),
    })),
  };
}

