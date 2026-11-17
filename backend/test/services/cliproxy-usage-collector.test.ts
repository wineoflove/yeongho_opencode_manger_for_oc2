import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migration-runner";
import { allMigrations } from "../../src/db/migrations";
import { CliproxyUsageCollector } from "../../src/services/cliproxy-usage-collector";
import type { ProxyUsageRecord } from "../../src/services/claude-proxy-usage-contract";

function record(executionId: string): ProxyUsageRecord {
  return {
    occurredAt: "2026-11-17T01:00:00.000Z",
    authIndex: "aa47ac1b75dc0765",
    provider: "codex",
    executorType: null,
    model: "gpt-6-astra",
    alias: null,
    responseModel: null,
    requestId: null,
    executionId,
    sessionId: null,
    failed: false,
    failureStatus: null,
    stream: null,
    latencyMs: null,
    accountingVersion: null,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 2,
    },
    breakdown: null,
  };
}

function page(records: readonly ProxyUsageRecord[], rejected = 0) {
  return { received: records.length + rejected, rejected, records };
}

describe("CLIProxy usage collector", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, allMigrations);
  });
  afterEach(() => db.close());

  function collector(pages: ReturnType<typeof page>[]) {
    const popUsageQueue = vi.fn(async () => pages.shift() ?? page([]));
    const listAccounts = vi.fn(async () => ({
      observedAt: "2026-11-17T01:00:00Z",
      accounts: [{ id: "aa47ac1b75dc0765", label: "user@example.test" }],
    }));
    const instance = new CliproxyUsageCollector({
      client: { popUsageQueue, listAccounts },
      db,
      pageSize: 2,
      maxPagesPerTick: 3,
      intervalMs: 1000,
      now: () => 500,
    });
    return { instance, popUsageQueue, listAccounts };
  }

  const rows = () =>
    db
      .prepare(
        "SELECT execution_id, account_label FROM cliproxy_usage_events ORDER BY id",
      )
      .all();

  it("drains full pages until a short page arrives", async () => {
    const { instance, popUsageQueue } = collector([
      page([record("a"), record("b")]),
      page([record("c")]),
      page([record("never")]),
    ]);
    expect(await instance.tick()).toEqual({
      received: 3,
      inserted: 3,
      skipped: 0,
      rejected: 0,
    });
    expect(popUsageQueue).toHaveBeenCalledTimes(2);
    expect(popUsageQueue).toHaveBeenCalledWith(2);
    expect(rows()).toEqual([
      { execution_id: "a", account_label: "user@example.test" },
      { execution_id: "b", account_label: "user@example.test" },
      { execution_id: "c", account_label: "user@example.test" },
    ]);
  });

  it("stops after the page cap even when the queue stays full", async () => {
    const { instance, popUsageQueue } = collector([
      page([record("a"), record("b")]),
      page([record("c"), record("d")]),
      page([record("e"), record("f")]),
      page([record("g"), record("h")]),
    ]);
    await instance.tick();
    expect(popUsageQueue).toHaveBeenCalledTimes(3);
  });

  it("counts rejected entries and caches account labels", async () => {
    const { instance, listAccounts } = collector([page([record("a")], 2)]);
    expect(await instance.tick()).toEqual({
      received: 3,
      inserted: 1,
      skipped: 0,
      rejected: 2,
    });
    await instance.tick();
    expect(listAccounts).toHaveBeenCalledTimes(1);
  });

  it("stores events without labels when account metadata is unavailable", async () => {
    const { instance, listAccounts } = collector([page([record("a")])]);
    listAccounts.mockRejectedValueOnce(new Error("unavailable"));
    await instance.tick();
    expect(rows()).toEqual([{ execution_id: "a", account_label: null }]);
  });

  it("waits for an in-flight tick when stopping and runs only one tick at a time", async () => {
    let release: () => void = () => {};
    const { instance, popUsageQueue } = collector([]);
    popUsageQueue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(page([record("late")]));
        }),
    );
    instance.start();
    const first = instance.tick();
    const second = instance.tick();
    const stopped = instance.stop();
    release();
    await Promise.all([first, second, stopped]);
    expect(popUsageQueue).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      { execution_id: "late", account_label: "user@example.test" },
    ]);
  });
});
