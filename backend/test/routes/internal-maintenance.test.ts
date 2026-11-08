import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { allMigrations } from "../../src/db/migrations";
import { getOrCreateInternalToken } from "../../src/services/internal-token";
import { migrate } from "../../src/db/migration-runner";
import type { OpenCodeClient } from "../../src/services/opencode/client";
import { createInternalTestApp } from "../helpers/internal-test-app";

type Api = { active: ReturnType<typeof vi.fn>; pty: ReturnType<typeof vi.fn> };

function client(api: Api): OpenCodeClient {
  return {
    api: { session: { active: api.active }, pty: { list: api.pty } },
    forwardRaw: vi.fn(),
  } as unknown as OpenCodeClient;
}

describe("internal/maintenance routes", () => {
  let db: Database;
  let token: string;
  let api: Api;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, allMigrations);
    token = getOrCreateInternalToken(db);
    api = {
      active: vi.fn(async () => ({})),
      pty: vi.fn(async () => ({ data: [] })),
    };
    app = new Hono().route(
      "/api/internal",
      createInternalTestApp(db, { openCodeClient: client(api) }),
    );
  });

  const status = async () => {
    const response = await app.request("/api/internal/maintenance/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as {
      ready: boolean;
      blockers: string[];
      counts: Record<string, number>;
      schemaVersion: number;
    };
  };

  it("requires the internal bearer token", async () => {
    expect((await app.request("/api/internal/maintenance/status")).status).toBe(
      401,
    );
    expect(api.active).not.toHaveBeenCalled();
  });

  it("reports ready with the version 1 contract when nothing is running", async () => {
    const body = await status();
    expect(body).toEqual({
      schemaVersion: 1,
      ready: true,
      blockers: [],
      counts: {
        enabledSchedules: 0,
        activeSchedules: 0,
        activeRecovery: 0,
        busySessions: 0,
        terminalSessions: 0,
        checkedDirectories: 2,
      },
    });
    expect(api.pty).toHaveBeenCalledTimes(2);
  });

  it("blocks on enabled schedules, running sessions, active goals and open terminals", async () => {
    db.run(
      `INSERT INTO repos (repo_url, local_path, branch, default_branch, clone_status, cloned_at) VALUES ('https://example.invalid/r.git', 'r', 'main', 'main', 'ready', 1)`,
    );
    db.run(
      `INSERT INTO schedule_jobs (repo_id, name, enabled, schedule_mode, interval_minutes, prompt, created_at, updated_at) VALUES (1, 'job', 1, 'interval', 60, 'p', 1, 1)`,
    );
    db.run(
      `INSERT INTO session_goals (session_id, directory, objective, status, max_continuations, created_at, updated_at) VALUES ('ses_a', '/w', 'o', 'active', 5, 1, 1)`,
    );
    api.active.mockResolvedValue({
      ses_a: { type: "running" },
      ses_b: { type: "running" },
    });
    api.pty.mockResolvedValueOnce({ data: [{ id: "pty_1" }] });
    const body = await status();
    expect(body.ready).toBe(false);
    expect(body.blockers.sort()).toEqual([
      "active_recovery",
      "busy_sessions",
      "enabled_schedules",
      "terminal_sessions",
    ]);
    expect(body.counts).toMatchObject({
      enabledSchedules: 1,
      activeRecovery: 1,
      busySessions: 2,
      terminalSessions: 1,
      checkedDirectories: 3,
    });
  });

  it("fails closed when OpenCode cannot report activity or terminals", async () => {
    api.active.mockRejectedValue(new Error("down"));
    api.pty.mockRejectedValue(new Error("down"));
    const body = await status();
    expect(body.ready).toBe(false);
    expect(body.blockers.sort()).toEqual([
      "directories_unknown",
      "session_status_unknown",
    ]);
    expect(body.counts.checkedDirectories).toBe(0);
  });

  it.each([
    ['an array of active sessions', [], { data: [] }, ['session_status_unknown']],
    ['a terminal page without a data array', {}, { data: {} }, ['directories_unknown']],
    ['a terminal page that is not an object', {}, null, ['directories_unknown']],
  ])('fails closed when OpenCode returns %s', async (_label, active, terminals, blockers) => {
    api.active.mockResolvedValue(active)
    api.pty.mockResolvedValue(terminals)
    const body = await status()
    expect(body.ready).toBe(false)
    expect(body.blockers).toEqual(blockers)
    expect(Number.isNaN(body.counts.terminalSessions)).toBe(false)
  })
})
