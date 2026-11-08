import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  WorkflowSessionTimelineSchema,
  WorkflowStatsResponseSchema,
} from "@opencode-manager/shared/schemas";
import { WorkflowStatsSource } from "../../src/services/stats/workflow-source";
import { createWorkflowRoutes } from "../../src/routes/workflow";

const NOW = Date.UTC(2026, 10, 7, 12);
const SESSION = "ses_workflowroot01";
const CHILD = "ses_workflowchild1";

function tool(
  name: string,
  status: string,
  input: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: { status, input, ...extra },
    time: { created: NOW - 5000 },
  };
}

function seed(path: string): Database {
  const db = new Database(path);
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, directory TEXT, agent TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_part(message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, data TEXT, PRIMARY KEY(message_id, ordinal));`);
  db.query("INSERT INTO session_v2 VALUES (?,?,?,?,?,?)").run(
    SESSION,
    null,
    "Root work",
    NOW - 60_000,
    "/w/repo",
    "build",
  );
  db.query("INSERT INTO session_v2 VALUES (?,?,?,?,?,?)").run(
    CHILD,
    SESSION,
    "Explore",
    NOW - 50_000,
    "/w/repo",
    "explore",
  );
  const add = db.query("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      agent: "build",
      model: { id: "gpt-x", providerID: "openai" },
      content,
      tokens: {
        input: 1000,
        output: 50,
        reasoning: 0,
        cache: { read: 200, write: 0 },
      },
      cost: 0,
      time: { created: NOW - 5000 },
      ...extra,
    });
  add.run(
    "msg_user",
    SESSION,
    "user",
    1,
    NOW - 6000,
    NOW - 6000,
    JSON.stringify({ text: "Fix it", time: { created: NOW - 6000 } }),
  );
  add.run(
    "msg_inline",
    SESSION,
    "assistant",
    2,
    NOW - 5000,
    NOW - 5000,
    assistant([
      { type: "text", text: "working" },
      tool(
        "shell",
        "completed",
        { command: "pnpm test" },
        {
          metadata: { exit: 1, status: "exited" },
          content: [{ type: "text", text: "FAIL tail" }],
        },
      ),
      tool(
        "shell",
        "completed",
        { command: "pnpm test" },
        {
          metadata: { exit: 124, status: "timeout" },
          content: [{ type: "text", text: "timed out" }],
        },
      ),
      tool(
        "read",
        "completed",
        { path: "/w/repo/a.ts" },
        { metadata: {}, content: [{ type: "text", text: "x" }] },
      ),
      tool(
        "edit",
        "error",
        { path: "/w/repo/a.ts" },
        {
          error: {
            type: "tool.failed",
            message: "OCM_GUARD_G1_COMPRESSED_CONTENT: refused",
          },
        },
      ),
    ]),
  );
  add.run(
    "msg_parts",
    SESSION,
    "assistant",
    3,
    NOW - 4000,
    NOW - 4000,
    assistant([{ type: "text", text: "stale inline" }]),
  );
  db.query("INSERT INTO session_part VALUES (?,?,?,?,?)").run(
    "msg_parts",
    SESSION,
    0,
    "tool",
    JSON.stringify(
      tool(
        "read",
        "completed",
        { path: "/w/repo/b.ts" },
        { metadata: { ocmGuard: { id: "G4" } } },
      ),
    ),
  );
  add.run(
    "msg_compact",
    SESSION,
    "compaction",
    4,
    NOW - 3000,
    NOW - 3000,
    JSON.stringify({
      status: "failed",
      reason: "auto",
      error: { message: "too large" },
      time: { created: NOW - 3000 },
    }),
  );
  add.run(
    "msg_child",
    CHILD,
    "assistant",
    1,
    NOW - 2000,
    NOW - 2000,
    assistant([], { agent: "explore" }),
  );
  add.run(
    "msg_old",
    SESSION,
    "assistant",
    5,
    NOW - 90 * 86_400_000,
    NOW,
    assistant([tool("shell", "error", { command: "old" })]),
  );
  return db;
}

test("computes OpenCode 2 workflow metrics from inline and normalized tool content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-workflow-"));
  const path = join(root, "opencode.db");
  const db = seed(path);
  const lookups: string[][] = [];
  const source = new WorkflowStatsSource({
    openCodeDbPath: path,
    searchLessons: async (queries) => {
      lookups.push([...queries]);
      return queries.map((query) => ({ query, ids: ["lesson-1"] }));
    },
    mcpStatus: async () => ({ directory: "/w/assistant", statuses: {} }),
    now: () => NOW,
  });
  try {
    const stats = WorkflowStatsResponseSchema.parse(
      await source.getStats("24h"),
    );
    expect(stats.totals.current.toolCalls).toBe(5);
    expect(stats.totals.current.statusErrors).toBe(1);
    expect(stats.totals.current.bashCalls).toBe(2);
    expect(stats.totals.current.bashNonzero).toBe(2);
    expect(stats.totals.current.bashTimeouts).toBe(1);
    expect(stats.totals.current.compactions).toBe(1);
    expect(stats.totals.current.compactionErrors).toBe(1);
    expect(stats.tools.map((row) => row.tool).sort()).toEqual([
      "bash",
      "edit",
      "read",
    ]);
    expect(stats.errorSignatures.length).toBeGreaterThan(0);
    expect(
      stats.errorSignatures.every((row) => Array.isArray(row.relatedLessonIds)),
    ).toBe(true);
    expect(lookups).toHaveLength(1);

    const timeline = WorkflowSessionTimelineSchema.parse(
      await source.getSessionTimeline(SESSION),
    );
    expect(timeline.steps.map((step) => step.messageId)).toEqual([
      "msg_inline",
      "msg_parts",
      "msg_old",
    ]);
    expect(timeline.steps[0]).toMatchObject({
      toolCalls: 4,
      toolErrors: 1,
      guardEvents: 1,
      contextTokens: 1200,
      outputTokens: 50,
      model: "openai/gpt-x",
    });
    expect(timeline.steps[1]).toMatchObject({ toolCalls: 1, guardEvents: 1 });
    expect(timeline.compactions).toEqual([
      { at: NOW - 3000, messageId: "msg_compact" },
    ]);
    expect(await source.getSessionTimeline("ses_missingsession1")).toBeNull();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow route rejects invalid ranges, malformed ids and reports an incompatible database", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-workflow-route-"));
  const path = join(root, "opencode.db");
  const legacy = new Database(path);
  legacy.exec(
    "CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT); CREATE TABLE part(id TEXT);",
  );
  legacy.close();
  const source = new WorkflowStatsSource({
    openCodeDbPath: path,
    searchLessons: async () => [],
    mcpStatus: async () => ({ directory: "/w", statuses: {} }),
    now: () => NOW,
  });
  try {
    const app = new Hono().route("/workflow", createWorkflowRoutes(source));
    expect((await app.request("/workflow?range=1y")).status).toBe(400);
    expect((await app.request("/workflow/sessions/not-a-session")).status).toBe(
      400,
    );
    const incompatible = await app.request("/workflow?range=7d");
    expect(incompatible.status).toBe(503);
    expect(await incompatible.json()).toEqual({
      error: "WORKFLOW_SOURCE_INCOMPATIBLE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
