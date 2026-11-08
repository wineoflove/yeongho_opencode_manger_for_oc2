import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "./data.mjs";

const OPENCODE_SCHEMA = `CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,directory TEXT NOT NULL);
  CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);
  CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,PRIMARY KEY(message_id,ordinal))`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "learning-review-test-"));
  const opencode = new Database(join(root, "opencode.sqlite"));
  const manager = new Database(join(root, "manager.sqlite"));
  opencode.exec(OPENCODE_SCHEMA);
  manager.exec(
    "CREATE TABLE repos(source_path TEXT,local_path TEXT); CREATE TABLE schedule_jobs(id INTEGER,name TEXT); CREATE TABLE schedule_runs(job_id INTEGER,session_id TEXT)",
  );
  manager.query("INSERT INTO repos VALUES (?,?)").run("/project", "project");
  manager
    .query("INSERT INTO schedule_jobs VALUES (?,?)")
    .run(5, "학습 일일 리뷰");
  manager.query("INSERT INTO schedule_runs VALUES (?,?)").run(5, "review");
  const config = {
    opencodeDb: join(root, "opencode.sqlite"),
    managerDb: join(root, "manager.sqlite"),
    directory: "/assistant",
    reposRoot: "/repos",
    feedbackSession: "feedback",
  };
  const message = opencode.query(
    "INSERT INTO session_message VALUES (?,?,?,?,?,?,?)",
  );
  return {
    root,
    opencode,
    config,
    session: (id, parent, dir, title = id) =>
      opencode
        .query("INSERT INTO session_v2 VALUES (?,?,?,?)")
        .run(id, parent, title, dir),
    message: (id, session, type, time, data) =>
      message.run(id, session, type, time, time, time, JSON.stringify(data)),
    close: async () => {
      opencode.close();
      manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const completed = (content, extra = {}) => ({
  time: { created: 1, completed: 2 },
  finish: "stop",
  content,
  ...extra,
});

it("collects completed registered-project evidence while excluding review descendants and unfinished output", async () => {
  const f = await fixture();
  try {
    for (const [id, parent, dir] of [
      ["normal", null, "/project"],
      ["review", null, "/project"],
      ["child", "review", "/project"],
      ["foreign", null, "/private"],
      ["feedback", null, "/assistant"],
    ]) {
      f.session(id, parent, dir);
      f.message(
        id,
        id,
        "assistant",
        100,
        completed([{ type: "text", text: "password=fixture-secret" }]),
      );
    }
    f.session("titled", null, "/project", "[Learning review] daily analysis");
    f.message(
      "titled",
      "titled",
      "assistant",
      100,
      completed([{ type: "text", text: "x" }]),
    );
    f.message("unfinished", "normal", "assistant", 101, {
      time: { created: 1 },
      content: [],
    });
    f.message("synthetic", "normal", "synthetic", 102, {
      text: "not user input",
    });
    const batch = await collect(f.config, "daily", { time: 0, id: "" }, 200);
    expect(batch.records.map((r) => r.id)).toEqual(["normal"]);
    expect(batch.records[0]).toMatchObject({
      role: "assistant",
      project: "project",
    });
    expect(JSON.stringify(batch)).not.toContain("fixture-secret");
    expect(
      (await collect(f.config, "daily", batch.cursor, 200)).records,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("maps OpenCode 2 user text, inline tool content, normalized parts and errors into bounded evidence", async () => {
  const f = await fixture();
  try {
    f.session("ses", null, "/project");
    f.message("u1", "ses", "user", 10, {
      text: "please run the tests",
      files: [],
      agents: [],
    });
    f.message(
      "a1",
      "ses",
      "assistant",
      11,
      completed(
        [
          { type: "reasoning", text: "hidden reasoning" },
          {
            type: "tool",
            name: "shell",
            state: {
              status: "error",
              input: { command: "pnpm test" },
              error: { type: "tool.failed", message: "exit 1 api_key=abc123" },
              content: [{ type: "text", text: `${"x".repeat(500)}FAIL tail` }],
            },
          },
        ],
        { error: { type: "provider", message: "rate limited" } },
      ),
    );
    f.message(
      "a2",
      "ses",
      "assistant",
      12,
      completed([{ type: "text", text: "stale inline" }]),
    );
    f.opencode
      .query("INSERT INTO session_part VALUES (?,?,?,?,?,?,?)")
      .run(
        "a2",
        "ses",
        0,
        "text",
        12,
        12,
        JSON.stringify({ type: "text", text: "normalized part" }),
      );
    const batch = await collect(f.config, "daily", { time: 0, id: "" }, 200);
    expect(batch.records.map((r) => [r.id, r.role])).toEqual([
      ["u1", "user"],
      ["a1", "assistant"],
      ["a2", "assistant"],
    ]);
    expect(batch.records[0].evidence).toEqual([
      { text: "please run the tests" },
    ]);
    const tool = batch.records[1].evidence[0];
    expect(tool).toMatchObject({ tool: "shell", status: "error" });
    expect(tool.error).toContain("exit 1");
    expect(tool.error).not.toContain("abc123");
    expect(tool.output.endsWith("FAIL tail")).toBe(true);
    expect(tool.output.length).toBe(400);
    expect(batch.records[1].error).toBe("rate limited");
    expect(batch.records[2].evidence).toEqual([{ text: "normalized part" }]);
    expect(batch.cursor).toEqual({ time: 12, id: "a2" });
  } finally {
    await f.close();
  }
});
