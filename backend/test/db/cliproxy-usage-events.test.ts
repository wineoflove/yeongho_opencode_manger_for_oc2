import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migration-runner";
import { allMigrations } from "../../src/db/migrations";
import { cliproxyUsageEventsMigration } from "../../src/db/migrations/202611171200-cliproxy-usage-events";
import {
  insertUsageEvents,
  listUsageEventsAfter,
  pruneUsageEventsBefore,
} from "../../src/db/cliproxy-usage-events";
import type { ProxyUsageRecord } from "../../src/services/claude-proxy-usage-contract";

function record(fields: Partial<ProxyUsageRecord> = {}): ProxyUsageRecord {
  return {
    occurredAt: "2026-11-17T01:00:00.000Z",
    authIndex: "aa47ac1b75dc0765",
    provider: "claude",
    executorType: "claude",
    model: "claude-opus-5-5",
    alias: "claude-opus-5-5",
    responseModel: "claude-opus-5-5",
    requestId: "req-1",
    executionId: "exec-1",
    sessionId: null,
    failed: false,
    failureStatus: null,
    stream: true,
    latencyMs: 10,
    accountingVersion: 2,
    tokens: {
      input: 10,
      output: 4,
      reasoning: 1,
      cached: 0,
      cacheRead: 6,
      cacheCreation: 2,
      total: 22,
    },
    breakdown: {
      quality: "complete",
      total: 22,
      input: { total: 18, uncached: 10, cacheRead: 6, cacheWrite: 2 },
      output: { total: 4, nonReasoning: 3, reasoning: 1 },
      unclassified: 0,
    },
    ...fields,
  };
}

describe("CLIProxy usage events storage", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, allMigrations);
  });
  afterEach(() => db.close());

  it("creates an additive table that repeats and drops cleanly", () => {
    cliproxyUsageEventsMigration.up(db);
    const columns = (
      db.prepare("PRAGMA table_info(cliproxy_usage_events)").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    for (const forbidden of [
      "api_key",
      "source",
      "response_headers",
      "access_token_sha256",
      "client_ip",
      "user_agent",
      "body",
    ])
      expect(columns).not.toContain(forbidden);
    cliproxyUsageEventsMigration.down(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'cliproxy_usage_events'",
        )
        .get() ?? null,
    ).toBeNull();
  });

  it("keeps one row per execution and falls back to the request id", () => {
    const labels = new Map([["aa47ac1b75dc0765", "user@example.test"]]);
    expect(insertUsageEvents(db, [record(), record()], labels, 100)).toEqual({
      inserted: 1,
      skipped: 1,
    });
    expect(
      insertUsageEvents(
        db,
        [record({ executionId: null, requestId: "req-2" })],
        labels,
        100,
      ),
    ).toEqual({
      inserted: 1,
      skipped: 0,
    });
    expect(
      insertUsageEvents(
        db,
        [record({ executionId: null, requestId: null })],
        labels,
        100,
      ),
    ).toEqual({
      inserted: 0,
      skipped: 1,
    });
    expect(
      db
        .prepare(
          "SELECT execution_id, account_label FROM cliproxy_usage_events ORDER BY id",
        )
        .all(),
    ).toEqual([
      { execution_id: "exec-1", account_label: "user@example.test" },
      { execution_id: "req-2", account_label: "user@example.test" },
    ]);
  });

  it("stores the non-overlapping token breakdown", () => {
    insertUsageEvents(db, [record()], new Map(), 100);
    expect(
      db
        .prepare(
          "SELECT input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, breakdown_quality FROM cliproxy_usage_events",
        )
        .get(),
    ).toEqual({
      input_tokens: 18,
      uncached_input_tokens: 10,
      cache_read_tokens: 6,
      cache_write_tokens: 2,
      output_tokens: 4,
      reasoning_tokens: 1,
      total_tokens: 22,
      breakdown_quality: "complete",
    });
  });

  it.each([
    [
      "claude",
      { input: 18, uncached: 10, cacheRead: 6, cacheWrite: 2, total: 22 },
    ],
    [
      "codex",
      { input: 10, uncached: 4, cacheRead: 6, cacheWrite: 2, total: 22 },
    ],
  ] as const)(
    "derives %s token columns without a breakdown",
    (provider, expected) => {
      insertUsageEvents(
        db,
        [record({ provider, breakdown: null })],
        new Map(),
        100,
      );
      const row = db
        .prepare(
          "SELECT input_tokens AS input, uncached_input_tokens AS uncached, cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, total_tokens AS total FROM cliproxy_usage_events",
        )
        .get();
      expect(row).toEqual(expected);
    },
  );

  it("does not count Claude cache creation as a cache read without a breakdown", () => {
    insertUsageEvents(
      db,
      [
        record({
          breakdown: null,
          tokens: {
            input: 2,
            output: 63,
            reasoning: 59,
            cached: 3785,
            cacheRead: 0,
            cacheCreation: 3785,
            total: 3850,
          },
        }),
      ],
      new Map(),
      100,
    );
    expect(
      db
        .prepare(
          "SELECT input_tokens AS input, uncached_input_tokens AS uncached, cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, output_tokens AS output, reasoning_tokens AS reasoning FROM cliproxy_usage_events",
        )
        .get(),
    ).toEqual({
      input: 3787,
      uncached: 2,
      cacheRead: 0,
      cacheWrite: 3785,
      output: 63,
      reasoning: 59,
    });
  });

  it("ignores providers outside Claude and Codex", () => {
    expect(
      insertUsageEvents(db, [record({ provider: "gemini" })], new Map(), 100),
    ).toEqual({
      inserted: 0,
      skipped: 1,
    });
  });

  it("prunes only events that occurred before the cutoff", () => {
    insertUsageEvents(
      db,
      [
        record({ executionId: "old", occurredAt: "2026-08-01T00:00:00.000Z" }),
        record({ executionId: "edge", occurredAt: "2026-08-19T00:00:00.000Z" }),
        record({ executionId: "new", occurredAt: "2026-11-17T00:00:00.000Z" }),
      ],
      new Map(),
      100,
    );
    expect(pruneUsageEventsBefore(db, Date.parse("2026-08-19T00:00:00.000Z"))).toBe(1);
    expect(listUsageEventsAfter(db, 0, 10).map((event) => event.id)).toEqual(["edge", "new"]);
    expect(pruneUsageEventsBefore(db, Date.parse("2026-08-19T00:00:00.000Z"))).toBe(0);
  });

  it("pages events after a row cursor in insertion order with every model name", () => {
    insertUsageEvents(
      db,
      [
        record({
          executionId: "b",
          occurredAt: "2026-11-17T01:00:02.000Z",
          sessionId: "session-b",
          responseModel: "claude-opus-5-5-20261101",
        }),
        record({
          executionId: "a",
          occurredAt: "2026-11-17T01:00:01.000Z",
          failed: true,
          failureStatus: 429,
        }),
      ],
      new Map([["aa47ac1b75dc0765", "user@example.test"]]),
      100,
    );
    const [first, second] = listUsageEventsAfter(db, 0, 10);
    expect(first).toEqual({
      rowId: 1,
      id: "b",
      provider: "claude",
      authIndex: "aa47ac1b75dc0765",
      label: "user@example.test",
      sessionId: "session-b",
      models: ["claude-opus-5-5", "claude-opus-5-5-20261101"],
      failed: false,
      failureStatus: null,
      occurredAt: Date.parse("2026-11-17T01:00:02.000Z"),
      tokens: {
        input: 18,
        uncached: 10,
        cacheRead: 6,
        cacheWrite: 2,
        output: 4,
        reasoning: 1,
        total: 22,
      },
    });
    expect(second).toMatchObject({ rowId: 2, id: "a", failed: true, failureStatus: 429 });
    expect(listUsageEventsAfter(db, 0, 1).map((event) => event.id)).toEqual(["b"]);
    expect(listUsageEventsAfter(db, 1, 10).map((event) => event.id)).toEqual(["a"]);
    expect(listUsageEventsAfter(db, 2, 10)).toEqual([]);
  });
});
