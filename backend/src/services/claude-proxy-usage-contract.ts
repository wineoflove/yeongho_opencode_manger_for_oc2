import { z } from "zod";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });

/** Passive quota observation CLIProxyAPI keeps from the last upstream response headers. */
export const quotaObservationSchema = z.object({
  observed_at: timestamp.optional(),
  signals: z.record(z.string(), z.string()).default({}),
});

export const cooldownSchema = z.object({
  scope: z.string(),
  model_key: z.string().optional(),
  reason: z.string(),
  retry_at: timestamp,
  remaining_seconds: count,
  http_status: z.number().int().optional(),
});

/** Credential fields used for usage views; any other upstream field (including the raw account) is stripped. */
export const usageCredentialFieldsSchema = z.object({
  account_type: z.string().optional(),
  quota: quotaObservationSchema.optional(),
  cooldowns: z.array(cooldownSchema).nullable().optional(),
  quota_blocked: z.boolean().optional(),
  renewal_state: z.string().optional(),
});

const breakdownSchema = z.object({
  quality: z.string(),
  total_tokens: count,
  input: z.object({
    total_tokens: count,
    uncached_tokens: count,
    cache_read_tokens: count,
    cache_write_tokens: count,
  }),
  output: z.object({
    total_tokens: count,
    non_reasoning_tokens: count,
    reasoning_tokens: count,
  }),
  unclassified_tokens: count,
});

/** One usage queue record reduced to the fields Manager is allowed to keep. */
export const usageRecordSchema = z.object({
  timestamp,
  auth_index: z.string().min(1),
  provider: z.string().min(1),
  executor_type: z.string().optional(),
  model: z.string().optional(),
  alias: z.string().optional(),
  response_model: z.string().optional(),
  request_id: z.string().optional(),
  execution_id: z.string().optional(),
  session_id: z.string().optional(),
  failed: z.boolean(),
  fail: z.object({ status_code: z.number().int() }).partial().optional(),
  stream: z.boolean().optional(),
  latency_ms: z.number().optional(),
  accounting_version: z.number().int().optional(),
  tokens: z.object({
    input_tokens: count.default(0),
    output_tokens: count.default(0),
    reasoning_tokens: count.default(0),
    cached_tokens: count.default(0),
    cache_read_tokens: count.default(0),
    cache_creation_tokens: count.default(0),
    total_tokens: count.default(0),
  }),
  token_breakdown: breakdownSchema.optional(),
});

/** A sanitized CLIProxyAPI usage event. */
export type ProxyUsageRecord = {
  readonly occurredAt: string;
  readonly authIndex: string;
  readonly provider: string;
  readonly executorType: string | null;
  readonly model: string | null;
  readonly alias: string | null;
  readonly responseModel: string | null;
  readonly requestId: string | null;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly failed: boolean;
  readonly failureStatus: number | null;
  readonly stream: boolean | null;
  readonly latencyMs: number | null;
  readonly accountingVersion: number | null;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cached: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
    readonly total: number;
  };
  readonly breakdown: {
    readonly quality: string;
    readonly total: number;
    readonly input: {
      readonly total: number;
      readonly uncached: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    };
    readonly output: {
      readonly total: number;
      readonly nonReasoning: number;
      readonly reasoning: number;
    };
    readonly unclassified: number;
  } | null;
};

/** Maps an allowlisted queue record to the Manager shape; a success never carries a failure status. */
export function toUsageRecord(
  entry: z.infer<typeof usageRecordSchema>,
): ProxyUsageRecord {
  const breakdown = entry.token_breakdown;
  return {
    occurredAt: entry.timestamp,
    authIndex: entry.auth_index,
    provider: entry.provider,
    executorType: entry.executor_type ?? null,
    model: entry.model ?? null,
    alias: entry.alias ?? null,
    responseModel: entry.response_model ?? null,
    requestId: entry.request_id ?? null,
    executionId: entry.execution_id ?? null,
    sessionId: entry.session_id ?? null,
    failed: entry.failed,
    failureStatus: entry.failed ? (entry.fail?.status_code ?? null) : null,
    stream: entry.stream ?? null,
    latencyMs: entry.latency_ms ?? null,
    accountingVersion: entry.accounting_version ?? null,
    tokens: {
      input: entry.tokens.input_tokens,
      output: entry.tokens.output_tokens,
      reasoning: entry.tokens.reasoning_tokens,
      cached: entry.tokens.cached_tokens,
      cacheRead: entry.tokens.cache_read_tokens,
      cacheCreation: entry.tokens.cache_creation_tokens,
      total: entry.tokens.total_tokens,
    },
    breakdown: breakdown
      ? {
          quality: breakdown.quality,
          total: breakdown.total_tokens,
          input: {
            total: breakdown.input.total_tokens,
            uncached: breakdown.input.uncached_tokens,
            cacheRead: breakdown.input.cache_read_tokens,
            cacheWrite: breakdown.input.cache_write_tokens,
          },
          output: {
            total: breakdown.output.total_tokens,
            nonReasoning: breakdown.output.non_reasoning_tokens,
            reasoning: breakdown.output.reasoning_tokens,
          },
          unclassified: breakdown.unclassified_tokens,
        }
      : null,
  };
}

/** Keeps the allowlisted records of one popped page and counts the entries that failed validation. */
export function toUsagePage(entries: readonly unknown[]): {
  readonly received: number;
  readonly rejected: number;
  readonly records: readonly ProxyUsageRecord[];
} {
  const records: ProxyUsageRecord[] = [];
  for (const entry of entries) {
    const parsed = usageRecordSchema.safeParse(entry);
    if (parsed.success) records.push(toUsageRecord(parsed.data));
  }
  return {
    received: entries.length,
    rejected: entries.length - records.length,
    records,
  };
}
