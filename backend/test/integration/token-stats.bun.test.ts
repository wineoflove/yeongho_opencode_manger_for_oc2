import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TokenStatsResponseSchema } from "@opencode-manager/shared/schemas";
import { TokenUsageIndex } from "../../src/services/stats/token-usage-index";
import {
  ModelPriceCache,
  buildPriceTable,
  estimateRecordCost,
} from "../../src/services/stats/pricing";
import { createStatsRoutes } from "../../src/routes/stats";

const T0 = Date.UTC(2026, 10, 1);

function seed(path: string): Database {
  const db = new Database(path);
  db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, agent TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO project VALUES ('prj', '/w/repo');
    INSERT INTO session_v2 VALUES ('ses_root', 'prj', NULL, '/w/repo/sub', 'Root task', 'build'),
      ('ses_child', 'prj', 'ses_root', '/w/repo', 'Child', 'explore'),
      ('ses_titled', 'prj', 'ses_root', '/w/repo', 'Look (@oracle subagent)', NULL);`);
  return db;
}

function assistant(
  tokens: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    agent: "build",
    model: { id: "gpt-x", providerID: "openai", variant: "high" },
    tokens,
    cost: 0,
    time: { created: T0 + 1000 },
    ...extra,
  });
}

test("indexes OpenCode 2 assistant usage with project, delegation category and incremental updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-token-stats-"));
  const dbPath = join(root, "opencode.db");
  const db = seed(dbPath);
  let clock = T0 + 10_000;
  const index = new TokenUsageIndex({
    openCodeDbPath: dbPath,
    listRepos: () => [{ fullPath: "/w/repo", name: "repo" }],
    refreshIntervalMs: 0,
    now: () => clock,
  });
  try {
    const add = db.query("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
    add.run(
      "msg_1",
      "ses_root",
      "assistant",
      1,
      T0,
      T0,
      assistant(
        { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } },
        { cost: 0.25 },
      ),
    );
    add.run(
      "msg_2",
      "ses_child",
      "assistant",
      1,
      T0,
      T0,
      assistant(
        { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        { agent: "explore" },
      ),
    );
    add.run(
      "msg_3",
      "ses_titled",
      "assistant",
      1,
      T0,
      T0,
      assistant({
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    );
    add.run(
      "msg_empty",
      "ses_root",
      "assistant",
      2,
      T0,
      T0,
      assistant({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    );
    add.run(
      "msg_user",
      "ses_root",
      "user",
      3,
      T0,
      T0,
      JSON.stringify({ text: "hi", tokens: { input: 999 } }),
    );
    add.run("msg_bad", "ses_root", "assistant", 4, T0, T0, "{not json");

    const first = await index.getSnapshot();
    expect(first.records.map((record) => record.messageId).sort()).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
    ]);
    const byId = new Map(
      first.records.map((record) => [record.messageId, record]),
    );
    expect(byId.get("msg_1")).toMatchObject({
      rootSessionId: "ses_root",
      cost: 0.25,
      input: 100,
      cacheRead: 50,
      cacheWrite: 2,
      keys: {
        model: "openai/gpt-x",
        provider: "openai",
        account: "openai:unattributed",
        project: "/w/repo",
        agent: "build",
        category: "main",
        session: "ses_root",
      },
    });
    expect(byId.get("msg_2")?.keys).toMatchObject({
      category: "@explore",
      session: "ses_root",
      agent: "explore",
    });
    expect(byId.get("msg_3")?.keys.category).toBe("@oracle");
    expect(first.label("project", "/w/repo")).toEqual({
      label: "repo",
      detail: "/w/repo",
    });
    expect(first.label("provider", "openai").label).toBe("OpenAI");
    expect(first.isAttributedAccount("openai:unattributed")).toBe(false);
    expect(first.firstMessageAt).toBe(T0 + 1000);

    clock += 10_000;
    add.run(
      "msg_4",
      "ses_root",
      "assistant",
      5,
      clock,
      clock,
      assistant({
        input: 4,
        output: 4,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    );
    db.query(
      "UPDATE session_message SET time_updated=?, data=? WHERE id=?",
    ).run(
      clock,
      assistant(
        { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        { cost: 0.25 },
      ),
      "msg_1",
    );
    db.query("DELETE FROM session_v2 WHERE id=?").run("ses_titled");
    const second = await index.getSnapshot();
    expect(second.records.map((record) => record.messageId).sort()).toEqual([
      "msg_1",
      "msg_2",
      "msg_4",
    ]);
    expect(
      second.records.find((record) => record.messageId === "msg_1")?.input,
    ).toBe(1);
  } finally {
    index.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("estimates API-equivalent cost only for zero-cost usage, with context tiers from the model catalog", () => {
  const prices = buildPriceTable([
    {
      providerID: "openai",
      modelID: "gpt-x",
      cost: [
        { input: 2, output: 8, cache: { read: 0.5, write: 1 } },
        {
          tier: { type: "context", size: 200_000 },
          input: 4,
          output: 16,
          cache: { read: 1, write: 2 },
        },
      ],
    },
  ]);
  const keys = {
    model: "openai/gpt-x",
    provider: "openai",
    account: "openai:unattributed",
    project: "/p",
    agent: "a",
    category: "main",
    session: "s",
  };
  const base = {
    messageId: "m",
    rootSessionId: "s",
    createdAt: T0,
    keys,
    reasoning: 0,
    cacheWrite: 0,
    cost: 0,
  };
  expect(
    estimateRecordCost(
      { ...base, input: 100_000, output: 100_000, cacheRead: 0 },
      prices,
    ).estimatedCost,
  ).toBeCloseTo(1);
  expect(
    estimateRecordCost(
      { ...base, input: 300_000, output: 0, cacheRead: 0 },
      prices,
    ).estimatedCost,
  ).toBeCloseTo(1.2);
  expect(
    estimateRecordCost(
      { ...base, input: 10, output: 0, cacheRead: 0, cost: 0.5 },
      prices,
    ),
  ).toEqual({ estimatedCost: 0, unpricedMessages: 0 });
  expect(
    estimateRecordCost(
      {
        ...base,
        keys: { ...keys, model: "openai/unknown" },
        input: 10,
        output: 0,
        cacheRead: 0,
      },
      prices,
    ),
  ).toEqual({ estimatedCost: 0, unpricedMessages: 1 });
});

test("keeps serving the last price table when the catalog is unavailable", async () => {
  let fail = false;
  let clock = 0;
  const cache = new ModelPriceCache(
    async () => {
      if (fail) throw new Error("OpenCode unavailable");
      return [
        {
          providerID: "openai",
          modelID: "gpt-x",
          cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
        },
      ];
    },
    10,
    () => clock,
  );
  expect((await cache.getPrices()).get("openai")?.has("gpt-x")).toBe(true);
  fail = true;
  clock = 100;
  expect((await cache.getPrices()).get("openai")?.has("gpt-x")).toBe(true);
});

test("stats route parses repeated filters, returns schema-valid totals and rejects malformed queries", async () => {
  const keys = {
    model: "openai/gpt-x",
    provider: "openai",
    account: "openai:unattributed",
    project: "/p",
    agent: "build",
    category: "main",
    session: "s",
  };
  const snapshot = {
    records: [
      {
        messageId: "m1",
        rootSessionId: "s",
        createdAt: T0 + 1,
        keys,
        input: 10,
        output: 5,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
      {
        messageId: "m2",
        rootSessionId: "s",
        createdAt: T0 + 2,
        keys: { ...keys, agent: "plan" },
        input: 1,
        output: 1,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    ],
    label: (_dimension: string, key: string) => ({ label: key }),
    isAttributedAccount: () => false,
    trackedSince: null,
    firstMessageAt: T0 + 1,
  };
  const prices = buildPriceTable([
    {
      providerID: "openai",
      modelID: "gpt-x",
      cost: [{ input: 1_000_000, output: 0, cache: { read: 0, write: 0 } }],
    },
  ]);
  const app = new Hono().route(
    "/stats",
    createStatsRoutes(
      { getSnapshot: async () => snapshot },
      { getPrices: async () => prices },
      () => T0 + 10,
    ),
  );
  const ok = await app.request(
    `/stats/tokens?from=${T0}&to=${T0 + 3_600_000}&filter=agent:build&groupBy=agent`,
  );
  expect(ok.status).toBe(200);
  const body = TokenStatsResponseSchema.parse(await ok.json());
  expect(body.totals.input).toBe(10);
  expect(body.totals.estimatedCost).toBe(10);
  expect(
    (await app.request(`/stats/tokens?from=${T0 + 10}&to=${T0}`)).status,
  ).toBe(400);
  expect((await app.request("/stats/tokens?from=abc&to=1")).status).toBe(400);
});
