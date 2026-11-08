import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "./cleanup.mjs";

const BATCH = "abcdef0123456789abcdef01";
const FINISHED = 1_000_000;

function fixture(sessions) {
  const root = mkdtempSync(join(tmpdir(), "review-cleanup-flow-"));
  mkdirSync(join(root, "state"));
  const managerDb = join(root, "manager.sqlite");
  const db = new Database(managerDb);
  db.exec(
    "CREATE TABLE schedule_jobs(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE schedule_runs(id INTEGER,job_id INTEGER,status TEXT,finished_at INTEGER,session_id TEXT,response_text TEXT);",
  );
  db.query("INSERT INTO schedule_jobs VALUES(?,?)").run(5, "학습 일일 리뷰");
  sessions.forEach((session, index) =>
    db
      .query("INSERT INTO schedule_runs VALUES(?,?,?,?,?,?)")
      .run(
        index + 1,
        5,
        "completed",
        FINISHED,
        session,
        JSON.stringify({ status: "done", mode: "daily", batch: BATCH }),
      ),
  );
  db.close();
  const ledger = new Database(join(root, "state", "reviews.sqlite"));
  ledger.exec(
    "CREATE TABLE runs (id TEXT PRIMARY KEY, mode TEXT, status TEXT, message_id TEXT, report TEXT)",
  );
  ledger
    .query("INSERT INTO runs VALUES (?,?,?,?,?)")
    .run(BATCH, "daily", "done", "msg_report", "보고서");
  ledger.close();
  return {
    root,
    config: {
      managerDb,
      store: root,
      directory: "/assistant",
      feedbackSession: "ses_feedback",
      cleanupJobIds: [5, 6],
      cleanupEnabledAt: 0,
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeApi({
  delivered = "보고서",
  active = {},
  later = [],
  children = [],
  permissions = [],
  forms = [],
  missing = [],
} = {}) {
  const removed = [];
  const notFound = () =>
    Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" });
  return {
    removed,
    api: {
      session: {
        active: async () => active,
        get: async ({ sessionID }) => {
          if (missing.includes(sessionID)) throw notFound();
          return {
            id: sessionID,
            location: { directory: "/assistant" },
            time: { created: 1, updated: FINISHED },
          };
        },
        list: async ({ parentID }) => ({
          data: children.filter((child) => child.parentID === parentID),
          cursor: {},
        }),
        form: {
          list: async ({ sessionID }) =>
            forms.filter((form) => form.sessionID === sessionID),
        },
        message: {
          get: async ({ messageID }) => {
            if (delivered === null || messageID !== "msg_report")
              throw Object.assign(new Error("missing"), {
                _tag: "MessageNotFoundError",
              });
            return { id: messageID, type: "user", text: delivered };
          },
        },
        remove: async ({ sessionID }) => removed.push(sessionID),
      },
      message: {
        list: async ({ sessionID }) => ({
          data: [
            {
              id: "m",
              time: {
                created: later.includes(sessionID)
                  ? FINISHED + 1
                  : FINISHED - 1,
              },
            },
          ],
          cursor: {},
        }),
      },
      permission: {
        list: async ({ sessionID }) =>
          permissions.filter((item) => item.sessionID === sessionID),
      },
    },
  };
}

const sessions = [
  "ses_clean",
  "ses_active",
  "ses_later",
  "ses_child",
  "ses_permission",
  "ses_form",
  "ses_gone",
];

it("removes only verified, idle, unchanged review sessions without pending work", async () => {
  const f = fixture(sessions);
  try {
    const fake = fakeApi({
      active: { ses_active: { type: "running" } },
      later: ["ses_later"],
      children: [{ id: "ses_sub", parentID: "ses_child" }],
      permissions: [{ sessionID: "ses_permission" }],
      forms: [{ sessionID: "ses_form" }],
      missing: ["ses_gone"],
    });
    expect(
      await cleanup({ ...f.config, delivery: "prompt" }, fake.api),
    ).toEqual({ removed: ["ses_clean"] });
    expect(fake.removed).toEqual(["ses_clean"]);
    expect(
      await cleanup({ ...f.config, delivery: "prompt" }, fake.api),
    ).toEqual({ removed: [] });
  } finally {
    f.close();
  }
});

it("keeps sessions whose report delivery cannot be verified", async () => {
  for (const delivered of [null, "다른 보고서"]) {
    const f = fixture(["ses_clean"]);
    try {
      const fake = fakeApi({ delivered });
      expect(
        await cleanup({ ...f.config, delivery: "prompt" }, fake.api),
      ).toEqual({ removed: [] });
    } finally {
      f.close();
    }
  }
});

it("verifies file deliveries from the stored report", async () => {
  const f = fixture(["ses_clean"]);
  try {
    const fake = fakeApi({ delivered: null });
    expect(await cleanup({ ...f.config, delivery: "file" }, fake.api)).toEqual({
      removed: [],
    });
    mkdirSync(join(f.root, "reviews", "delivered"), { recursive: true });
    writeFileSync(
      join(f.root, "reviews", "delivered", "msg_report.md"),
      "보고서",
    );
    expect(await cleanup({ ...f.config, delivery: "file" }, fake.api)).toEqual({
      removed: ["ses_clean"],
    });
  } finally {
    f.close();
  }
});

it('keeps every session when OpenCode returns malformed state', async () => {
  const cases = [
    (api) => ({ ...api, session: { ...api.session, active: async () => [] } }),
    (api) => ({
      ...api,
      session: { ...api.session, get: async ({ sessionID }) => ({ id: sessionID, location: { directory: '/assistant' }, time: {} }) },
    }),
    (api) => ({ ...api, message: { list: async () => ({ data: [{ id: 'm', time: {} }], cursor: {} }) } }),
    (api) => ({ ...api, permission: { list: async () => ({}) } }),
    (api) => ({ ...api, session: { ...api.session, form: { list: async () => null } } }),
  ]
  for (const corrupt of cases) {
    const f = fixture(['ses_clean'])
    try {
      const fake = fakeApi()
      const api = corrupt(fake.api)
      await cleanup({ ...f.config, delivery: 'prompt' }, api).catch(() => undefined)
      expect(fake.removed).toEqual([])
    } finally {
      f.close()
    }
  }
})

