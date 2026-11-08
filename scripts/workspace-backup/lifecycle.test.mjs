import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eligible,
  lifecycle,
  reportMatchesSource,
  successMarker,
} from "./lifecycle.mjs";

const config = {
  enabledAt: 1000,
  graceMs: 300000,
  feedbackSession: "ses_report",
  directory: "/assistant",
  delivery: "prompt",
  jobId: 2,
};
const run = {
  id: 1,
  job_id: 2,
  repo_id: 0,
  started_at: 2000,
  finished_at: 3000,
  status: "completed",
  session_id: "ses_run",
  session_title: "backup",
  response_text: `Verified main == origin/main\n${successMarker}`,
  error_text: null,
};

it("only admits future terminal runs of the configured job after grace, never the report session", () => {
  expect(eligible(run, config, 303000)).toBe(true);
  for (const patch of [
    { job_id: 5 },
    { repo_id: 1 },
    { started_at: 999 },
    { status: "running" },
    { finished_at: null },
    { session_id: "ses_report" },
  ])
    expect(eligible({ ...run, ...patch }, config, 303000)).toBe(false);
  expect(eligible(run, config, 302999)).toBe(false);
  expect(eligible({ ...run, job_id: 7 }, { ...config, jobId: 7 }, 303000)).toBe(
    true,
  );
});

it("preserves known legacy outbox text without accepting changed source content", () => {
  const report = `## Workspace config backup / run 1\n\nFinished: 1970-01-01T00:00:03.000Z\nStatus: completed\nSource session: ses_run\n\nVerified main == origin/main\n${successMarker}\n`;
  expect(reportMatchesSource(run, report)).toBe(true);
  expect(
    reportMatchesSource({ ...run, response_text: "changed" }, report),
  ).toBe(false);
});

const missing = (tag) => Object.assign(new Error("missing"), { _tag: tag });

async function fixture(patch = {}, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), "backup-lifecycle-"));
  const settings = {
    ...config,
    managerDb: join(folder, "manager.sqlite"),
    ledger: join(folder, "ledger.sqlite"),
    store: folder,
  };
  const database = new Database(settings.managerDb);
  database.exec(`CREATE TABLE schedule_jobs(id INTEGER,repo_id INTEGER,name TEXT);
    INSERT INTO schedule_jobs VALUES(2,0,'workspace-config-backup');
    CREATE TABLE schedule_runs(id INTEGER,job_id INTEGER,repo_id INTEGER,started_at INTEGER,finished_at INTEGER,
      status TEXT,session_id TEXT,session_title TEXT,response_text TEXT,error_text TEXT);`);
  const source = { ...run, ...patch };
  database
    .query("INSERT INTO schedule_runs VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      source.id,
      source.job_id,
      source.repo_id,
      source.started_at,
      source.finished_at,
      source.status,
      source.session_id,
      source.session_title,
      source.response_text,
      source.error_text,
    );
  database.close();
  const reports = new Map();
  const removed = [];
  let posts = 0;
  const base = {
    session: {
      prompt: async ({ sessionID, id, text }) => {
        expect(sessionID).toBe("ses_report");
        posts++;
        if (!options.undelivered && !(options.recover && posts === 1))
          reports.set(id, { id, type: "user", text });
      },
      message: {
        get: async ({ messageID }) => {
          const message = reports.get(messageID);
          if (!message) throw missing("MessageNotFoundError");
          return message;
        },
      },
      active: async () =>
        options.active ? { ses_run: { type: "running" } } : {},
      get: async ({ sessionID }) => {
        if (options.gone) throw missing("SessionNotFoundError");
        return {
          id: sessionID,
          title: "backup",
          location: { directory: "/assistant" },
          time: { created: 2001, updated: options.reused ? 4000 : 2900 },
        };
      },
      list: async () => ({
        data: options.children ? [{ id: "ses_child" }] : [],
        cursor: {},
      }),
      form: { list: async () => (options.form ? [{ id: "frm_1" }] : []) },
      remove: async ({ sessionID }) => removed.push(sessionID),
    },
    message: {
      list: async () => ({
        data: [{ id: "msg_x", time: { created: options.later ? 3500 : 2500 } }],
        cursor: {},
      }),
    },
    permission: {
      list: async () => (options.permission ? [{ id: "per_1" }] : []),
    },
  };
  const api = options.corrupt ? options.corrupt(base) : base;
  const verify = async () => {
    const original = setTimeout;
    globalThis.setTimeout = (callback) => original(callback, 0);
    try {
      const first = await lifecycle(settings, api, 303001);
      await lifecycle(settings, api, 303002);
      return first;
    } finally {
      globalThis.setTimeout = original;
    }
  };
  try {
    const first = await verify();
    return { first, posts, removed, reports };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

it("publishes once and removes only the exactly delivered successful run", async () => {
  const result = await fixture();
  expect(result.posts).toBe(1);
  expect(result.removed).toEqual(["ses_run"]);
  expect(result.first.removed).toEqual(["ses_run"]);
});

it("retains unconfirmed, active, reused, later, interactive and missing sessions", async () => {
  for (const options of [
    { undelivered: true },
    { active: true },
    { reused: true },
    { later: true },
    { children: true },
    { permission: true },
    { form: true },
    { gone: true },
  ])
    expect((await fixture({}, options)).removed).toEqual([]);
  for (const patch of [
    { status: "failed" },
    { response_text: "backup failed" },
    { error_text: "failure" },
  ]) {
    const result = await fixture(patch);
    expect(result.removed).toEqual([]);
    expect(result.posts).toBe(1);
  }
});

it("does not publish or remove historical sessions", async () => {
  const result = await fixture({ started_at: 999 });
  expect(result.posts).toBe(0);
  expect(result.removed).toEqual([]);
});

it("retries an unconfirmed delivery and removes only after a later readback succeeds", async () => {
  const result = await fixture({}, { recover: true });
  expect(result.first.errors).toEqual([1]);
  expect(result.first.removed).toEqual([]);
  expect(result.posts).toBe(2);
  expect(result.reports.size).toBe(1);
  expect(result.removed).toEqual(["ses_run"]);
});

it("retains sessions when OpenCode returns malformed state", async () => {
  for (const corrupt of [
    (api) => ({ ...api, session: { ...api.session, active: async () => [] } }),
    (api) => ({
      ...api,
      session: {
        ...api.session,
        get: async () => ({ id: "ses_run", title: "backup", location: { directory: "/assistant" }, time: {} }),
      },
    }),
    (api) => ({ ...api, message: { list: async () => ({ data: [{ id: "msg_x", time: {} }], cursor: {} }) } }),
    (api) => ({ ...api, permission: { list: async () => ({}) } }),
    (api) => ({ ...api, session: { ...api.session, list: async () => ({}) } }),
  ]) {
    const result = await fixture({}, { corrupt });
    expect(result.removed).toEqual([]);
    expect(result.posts).toBe(1);
  }
});
