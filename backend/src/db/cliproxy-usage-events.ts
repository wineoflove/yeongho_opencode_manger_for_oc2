import type { Database } from "bun:sqlite";
import type { ProxyUsageRecord } from "../services/claude-proxy-usage-contract";

/** Provider names CLIProxyAPI reports for the accounts Manager tracks. */
export type UsageEventProvider = "claude" | "codex";

/** Non-overlapping token columns; `input` includes cache reads and writes. */
export type UsageEventTokens = {
  readonly input: number;
  readonly uncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
};

/** A stored CLIProxyAPI usage event used for account attribution. */
export type StoredUsageEvent = {
  readonly id: string;
  readonly provider: UsageEventProvider;
  readonly authIndex: string;
  readonly label: string | null;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly failed: boolean;
  readonly failureStatus: number | null;
  readonly occurredAt: number;
  readonly tokens: UsageEventTokens;
};

type UsageEventRow = {
  execution_id: string;
  provider: UsageEventProvider;
  auth_index: string;
  account_label: string | null;
  session_id: string | null;
  model: string | null;
  failed: number;
  failure_status: number | null;
  occurred_at: number;
  input_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
};

function isTrackedProvider(provider: string): provider is UsageEventProvider {
  return provider === "claude" || provider === "codex";
}

function toTokens(
  record: ProxyUsageRecord,
  provider: UsageEventProvider,
): UsageEventTokens {
  const { breakdown, tokens } = record;
  if (breakdown) {
    return {
      input: breakdown.input.total,
      uncached: breakdown.input.uncached,
      cacheRead: breakdown.input.cacheRead,
      cacheWrite: breakdown.input.cacheWrite,
      output: breakdown.output.total,
      reasoning: breakdown.output.reasoning,
      total: breakdown.total,
    };
  }
  const cacheRead = tokens.cacheRead;
  const cacheWrite = tokens.cacheCreation;
  const input =
    provider === "claude"
      ? tokens.input + cacheRead + cacheWrite
      : tokens.input;
  const uncached =
    provider === "claude"
      ? tokens.input
      : Math.max(0, tokens.input - cacheRead);
  return {
    input,
    uncached,
    cacheRead,
    cacheWrite,
    output: tokens.output,
    reasoning: tokens.reasoning,
    total: tokens.total,
  };
}

/** Persists queue records once per execution; records without an identity or tracked provider are skipped. */
export function insertUsageEvents(
  db: Database,
  records: readonly ProxyUsageRecord[],
  labels: ReadonlyMap<string, string>,
  collectedAt: number,
): { inserted: number; skipped: number } {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO cliproxy_usage_events (
      execution_id, request_id, occurred_at, auth_index, account_label, provider, executor_type, model, alias,
      response_model, session_id, failed, failure_status, stream, latency_ms, accounting_version, input_tokens,
      uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
      breakdown_quality, collected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const record of records) {
      const identity = record.executionId ?? record.requestId;
      const occurredAt = Date.parse(record.occurredAt);
      if (
        !identity ||
        !isTrackedProvider(record.provider) ||
        Number.isNaN(occurredAt)
      ) {
        skipped += 1;
        continue;
      }
      const tokens = toTokens(record, record.provider);
      const result = statement.run(
        identity,
        record.requestId,
        occurredAt,
        record.authIndex,
        labels.get(record.authIndex) ?? null,
        record.provider,
        record.executorType,
        record.model,
        record.alias,
        record.responseModel,
        record.sessionId,
        record.failed ? 1 : 0,
        record.failureStatus,
        record.stream === null ? null : record.stream ? 1 : 0,
        record.latencyMs === null ? null : Math.round(record.latencyMs),
        record.accountingVersion,
        tokens.input,
        tokens.uncached,
        tokens.cacheRead,
        tokens.cacheWrite,
        tokens.output,
        tokens.reasoning,
        tokens.total,
        record.breakdown?.quality ?? null,
        collectedAt,
      );
      if (result.changes > 0) inserted += 1;
      else skipped += 1;
    }
  })();
  return { inserted, skipped };
}

/** Earliest stored event time, used as the start of account tracking. */
export function firstUsageEventAt(db: Database): number | null {
  const row = db
    .prepare("SELECT MIN(occurred_at) AS first FROM cliproxy_usage_events")
    .get() as {
    first: number | null;
  } | null;
  return row?.first ?? null;
}

/** Events at or after `since`, oldest first. */
export function listUsageEventsSince(
  db: Database,
  since: number,
): StoredUsageEvent[] {
  const rows = db
    .prepare(
      `SELECT execution_id, provider, auth_index, account_label, session_id, model, failed, failure_status, occurred_at,
        input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
        total_tokens
      FROM cliproxy_usage_events WHERE occurred_at >= ? ORDER BY occurred_at, id`,
    )
    .all(since) as UsageEventRow[];
  return rows.map((row) => ({
    id: row.execution_id,
    provider: row.provider,
    authIndex: row.auth_index,
    label: row.account_label,
    sessionId: row.session_id,
    model: row.model,
    failed: row.failed === 1,
    failureStatus: row.failure_status,
    occurredAt: row.occurred_at,
    tokens: {
      input: row.input_tokens,
      uncached: row.uncached_input_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      total: row.total_tokens,
    },
  }));
}
