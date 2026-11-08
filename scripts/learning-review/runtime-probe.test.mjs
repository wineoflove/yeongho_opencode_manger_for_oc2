import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, decision } from "./application-fixtures.mjs";
import {
  applicationInventory,
  recordApplication,
} from "./application-store.mjs";
import { Config } from "./application-files.mjs";
import { probeRuntime } from "./runtime-probe.mjs";
import { syncRuntime } from "./runtime-sync.mjs";
import { editClaims } from "./edit-claims.mjs";

const BODY = "# Assistant\n\n## Safety\nKeep approval boundaries.";

async function agentFixture() {
  const f = await fixture();
  const agents = join(f.root, "agents");
  await mkdir(agents);
  const policy = join(agents, "assistant.md");
  await writeFile(policy, `---\nmode: primary\n---\n${BODY}\n`);
  const sessionDb = join(f.root, "opencode.db");
  const config = Config.parse({
    ...f.config,
    policies: [
      {
        id: "assistant",
        path: policy,
        mutable: true,
        protectedHeadings: ["Safety"],
      },
    ],
    runtime: { directory: f.root, sessionDb },
  });
  return { ...f, policy, config, sessionDb };
}

function runtimeApi({ agents = [], skills = [], active = {} } = {}) {
  const locations = [];
  return {
    locations,
    api: {
      agent: {
        list: async ({ location }) => {
          locations.push(location);
          return { location, data: agents };
        },
      },
      skill: { list: async ({ location }) => ({ location, data: skills }) },
      session: { active: async () => active },
    },
  };
}

const failing = {
  agent: {
    list: async () => {
      throw new Error("server must not be called");
    },
  },
  session: {
    active: async () => {
      throw new Error("server must not be called");
    },
  },
};

it("verifies a loaded OpenCode 2 agent system prompt against the file body and reports a stale prompt", async () => {
  const f = await agentFixture();
  try {
    const fresh = runtimeApi({
      agents: [{ id: "assistant", name: "assistant", system: BODY }],
    });
    expect(await probeRuntime(f.config, f.policy, fresh.api)).toMatchObject({
      matches: true,
      exitCode: 0,
      origin: "runtime-probe",
    });
    expect(fresh.locations).toEqual([{ directory: f.root }]);
    const stale = runtimeApi({
      agents: [
        { id: "assistant", name: "assistant", system: "# Assistant\nold" },
      ],
    });
    expect(await probeRuntime(f.config, f.policy, stale.api)).toMatchObject({
      matches: false,
      exitCode: 2,
    });
    await expect(
      probeRuntime(f.config, f.policy, runtimeApi().api),
    ).rejects.toThrow("RUNTIME_TARGET_NOT_LOADED");
  } finally {
    await f.close();
  }
});

it("matches a skill by its resolved path and compares its served content", async () => {
  const f = await agentFixture();
  try {
    const folder = join(f.root, "skills", "review");
    await mkdir(folder, { recursive: true });
    const skill = join(folder, "SKILL.md");
    await writeFile(skill, "---\nname: review\n---\nReview carefully.\n");
    const config = Config.parse({
      ...f.config,
      policies: [
        ...f.config.policies,
        { id: "review", path: skill, mutable: true, protectedHeadings: [] },
      ],
    });
    const served = runtimeApi({
      skills: [
        {
          id: "review",
          name: "review",
          path: skill,
          content: "Review carefully.",
        },
      ],
    });
    expect(await probeRuntime(config, skill, served.api)).toMatchObject({
      matches: true,
    });
  } finally {
    await f.close();
  }
});

it("promotes pending runtime only when every target is loaded and keeps a stale target pending", async () => {
  const f = await agentFixture();
  try {
    f.config.policies[0].path = f.policy;
    await recordApplication(
      f.config,
      await decision({ ...f, config: f.config, policy: f.policy }),
    );
    const stale = await syncRuntime(
      f.config,
      runtimeApi({
        agents: [{ id: "assistant", name: "assistant", system: "old" }],
      }).api,
    );
    expect(stale.counts).toMatchObject({
      verified: 0,
      reloadPending: 1,
      failed: 0,
    });
    expect((await applicationInventory(f.config)).items[0].runtime).toBe(
      "pending",
    );
    const synced = await syncRuntime(
      f.config,
      runtimeApi({
        agents: [{ id: "assistant", name: "assistant", system: BODY }],
      }).api,
    );
    expect(synced.counts).toMatchObject({ verified: 1, failed: 0 });
    expect((await applicationInventory(f.config)).items[0]).toMatchObject({
      state: "applied",
      runtime: "verified",
    });
  } finally {
    await f.close();
  }
});

it("marks per-request and procedure documents as not requiring reload without probing the server", async () => {
  const f = await fixture();
  try {
    const agentsFile = join(f.root, "AGENTS.md");
    await writeFile(agentsFile, "# Rules\nUse checks.\n");
    const config = Config.parse({
      ...f.config,
      policies: [
        ...f.config.policies,
        {
          id: "agents",
          path: agentsFile,
          mutable: true,
          protectedHeadings: [],
        },
      ],
      runtime: { directory: f.root, sessionDb: join(f.root, "db") },
    });
    await recordApplication(
      config,
      await decision({ ...f, config, policy: agentsFile }),
    );
    const synced = await syncRuntime(config, failing);
    expect(synced.counts).toMatchObject({ notRequired: 1, failed: 0 });
    expect((await applicationInventory(config)).items[0]).toMatchObject({
      state: "applied",
      runtime: "not_required",
    });
  } finally {
    await f.close();
  }
});

function sessionDb(path) {
  const db = new Database(path);
  db.run(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT NOT NULL)",
  );
  db.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  db.run(
    "CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY (message_id, ordinal))",
  );
  let seq = 0;
  return {
    db,
    session: (id, parent, title, directory) =>
      db.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?)", [
        id,
        parent,
        title,
        directory,
      ]),
    inline: (session, at, tool) =>
      db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [
        `msg_${++seq}`,
        session,
        "assistant",
        seq,
        at,
        at,
        JSON.stringify({
          time: { created: at, completed: at },
          content: [{ type: "tool", ...tool }],
        }),
      ]),
    part: (session, at, tool) => {
      const id = `msg_${++seq}`;
      db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [
        id,
        session,
        "assistant",
        seq,
        at,
        at,
        JSON.stringify({
          time: { created: at },
          content: [{ type: "tool", name: "stale-inline" }],
        }),
      ]);
      db.run("INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?)", [
        id,
        session,
        0,
        "tool",
        at,
        at,
        JSON.stringify({ type: "tool", ...tool }),
      ]);
    },
  };
}

it("treats only recent or busy foreign OpenCode 2 edits of the exact target as conflicts", async () => {
  const f = await agentFixture();
  try {
    const s = sessionDb(f.sessionDb);
    const now = Date.parse("2026-10-28T00:00:00Z");
    for (const row of [
      ["self", "scheduler", "job", f.root],
      ["scheduler", null, "scheduler", f.root],
      ["old", null, "old work", f.root],
      ["busy", null, "long chat", f.root],
      ["recent", null, "recent edit", f.root],
      ["relative", null, "relative edit", join(f.root, "agents")],
      ["other-file", null, "unrelated", f.root],
      ["reader", null, "read only", f.root],
    ])
      s.session(...row);
    const patch = (path) => ({
      name: "patch",
      state: {
        input: { patchText: `*** Begin Patch\n*** Update File: ${path}\n` },
      },
    });
    s.inline("self", now - 1000, patch(f.policy));
    s.inline("old", now - 5 * 3600000, patch(f.policy));
    s.part("busy", now - 3 * 3600000, {
      name: "edit",
      state: { input: { path: f.policy } },
    });
    s.inline("recent", now - 60000, {
      name: "write",
      state: { input: { path: f.policy } },
    });
    s.inline("relative", now - 60000, {
      name: "edit",
      state: { input: { path: "assistant.md" } },
    });
    s.inline("other-file", now - 1000, patch(join(f.root, "assistant.md")));
    s.inline("reader", now - 1000, {
      name: "read",
      state: { input: { path: f.policy } },
    });
    s.db.close();
    const status = runtimeApi({
      active: {
        busy: { type: "running" },
        self: { type: "running" },
        other: { type: "running" },
      },
    });
    const claims = await editClaims(f.config, f.policy, {
      self: "self",
      now,
      api: status.api,
    });
    expect(claims.conflicts.map((item) => item.sessionId).sort()).toEqual([
      "busy",
      "recent",
      "relative",
    ]);
    expect(
      claims.conflicts.find((item) => item.sessionId === "busy"),
    ).toMatchObject({ busy: true });
    expect(claims.editingSessions).toBe(5);
    expect(claims.free).toBe(false);
  } finally {
    await f.close();
  }
});

it("finds edits recorded through a symlinked spelling of the target path", async () => {
  const f = await agentFixture();
  try {
    const alias = join(f.root, "alias");
    await symlink(join(f.root, "agents"), alias);
    const s = sessionDb(f.sessionDb);
    const now = Date.parse("2026-10-28T00:00:00Z");
    s.session("writer", null, "writer", f.root);
    s.inline("writer", now - 60000, {
      name: "edit",
      state: { input: { path: join(alias, "assistant.md") } },
    });
    s.db.close();
    const quiet = runtimeApi().api;
    const viaReal = await editClaims(f.config, await realpath(f.policy), {
      self: "me",
      now,
      api: quiet,
    });
    const viaAlias = await editClaims(f.config, join(alias, "assistant.md"), {
      self: "me",
      now,
      api: quiet,
    });
    expect(viaReal.conflicts.map((item) => item.sessionId)).toEqual(["writer"]);
    expect(viaAlias.conflicts.map((item) => item.sessionId)).toEqual([
      "writer",
    ]);
    expect(viaReal.path).toBe(viaAlias.path);
  } finally {
    await f.close();
  }
});

it("does not contact OpenCode when no foreign session edited the target", async () => {
  const f = await agentFixture();
  try {
    sessionDb(f.sessionDb).db.close();
    const claims = await editClaims(f.config, f.policy, {
      self: "me",
      now: Date.now(),
      api: failing,
    });
    expect(claims).toMatchObject({
      editingSessions: 0,
      conflicts: [],
      free: true,
    });
  } finally {
    await f.close();
  }
});
