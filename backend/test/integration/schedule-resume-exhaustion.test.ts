import { describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildOpenCodeBasicAuth } from "@opencode-manager/shared/opencode";
import { migrate } from "../../src/db/migration-runner";
import { allMigrations } from "../../src/db/migrations";
import {
  createScheduleJob,
  createScheduleRun,
  getScheduleRunById,
} from "../../src/db/schedules";
import { buildCreateSchedulePersistenceInput } from "../../src/services/schedule-config";
import { FetchOpenCodeClient } from "../../src/services/opencode/client";
import * as upstream from "../../src/services/opencode/upstream";
import { ScheduleService } from "../../src/services/schedules";
import { ScheduleWorktreeManager } from "../../src/services/schedule-worktree";
import { GitAuthService } from "../../src/services/git-auth";
import { sseAggregator } from "../../src/services/sse-aggregator";
import {
  createOpenCodeServeDirectories,
  resolveOpenCode2Binary,
  startOpenCodeServe,
} from "../helpers/opencode-binary";
import type { OpenCodeServe } from "../helpers/opencode-binary";

const binary = resolveOpenCode2Binary();

describe.skipIf(binary === null)(
  "scheduled run after OpenCode stops resuming a crash-looping turn",
  () => {
    it("marks the run failed instead of leaving it running", async () => {
      const directories = await createOpenCodeServeDirectories();
      const directory = join(directories.root, "repo");
      const db = new Database(":memory:");
      const open = new Set<ServerResponse>();
      let requests = 0;
      const llm = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          requests++;
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          const chunk = {
            id: `hang-${requests}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
          };
          response.write(
            `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }] })}\n\n`,
          );
          open.add(response);
          response.on("close", () => open.delete(response));
        });
      });
      let server: OpenCodeServe | undefined;
      let service: ScheduleService | undefined;
      try {
        const listening = once(llm, "listening");
        llm.listen(0, "127.0.0.1");
        await listening;
        const address = llm.address();
        if (!address || typeof address === "string")
          throw new Error("Fixture listener is unavailable");
        await mkdir(directory);
        await mkdir(join(directories.configHome, "opencode"), {
          recursive: true,
        });
        await writeFile(
          join(directories.configHome, "opencode", "opencode.json"),
          JSON.stringify({
            autoupdate: false,
            providers: {
              mock: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: "fixture",
                },
                models: { fixture: { name: "Fixture" } },
              },
            },
            model: "mock/fixture",
          }),
        );
        server = await startOpenCodeServe({
          service: true,
          directories,
          env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
        });
        const port = server.port;
        const password = server.password;
        const client = () =>
          new FetchOpenCodeClient({
            baseUrl: `http://127.0.0.1:${port}`,
            basicAuth: buildOpenCodeBasicAuth(password),
            defaultDirectory: false,
          });
        const api = client().api;
        const session = await api.session.create({
          title: "Resume exhaustion verification",
          location: { directory },
          model: { providerID: "mock", id: "fixture" },
        });
        migrate(db, allMigrations);
        db.prepare(
          `INSERT INTO repos (id, local_path, source_path, default_branch, clone_status, cloned_at) VALUES (1, 'resume-fixture', ?, 'main', 'ready', 1)`,
        ).run(directory);
        const job = createScheduleJob(
          db,
          1,
          buildCreateSchedulePersistenceInput({
            name: "Resume exhaustion verification",
            enabled: false,
            scheduleMode: "interval",
            intervalMinutes: 60,
            prompt: "Work forever",
            model: "mock/fixture",
          }),
        );
        const run = createScheduleRun(db, {
          repoId: 1,
          jobId: job.id,
          triggerSource: "manual",
          status: "running",
          startedAt: Date.now(),
          createdAt: Date.now(),
        });
        db.prepare("UPDATE schedule_runs SET session_id = ? WHERE id = ?").run(
          session.id,
          run.id,
        );
        await api.session.prompt({
          sessionID: session.id,
          text: "Work forever",
        });
        const isActive = async () =>
          Boolean((await client().api.session.active())[session.id]);
        await expect.poll(isActive, { timeout: 15000 }).toBe(true);
        let restarts = 0;
        for (; restarts < 14; restarts++) {
          const before = requests;
          await server.kill();
          server = undefined;
          server = await startOpenCodeServe({
            service: true,
            directories,
            port,
            password,
            env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
          });
          const resumed = await expect
            .poll(async () => requests > before || !(await isActive()), {
              timeout: 15000,
            })
            .toBe(true)
            .then(() => requests > before);
          if (!resumed) break;
        }
        expect(restarts).toBeGreaterThanOrEqual(9);
        expect(restarts).toBeLessThan(14);
        const stopped = await client().api.session.get({
          sessionID: session.id,
        });
        expect(
          stopped.outcome === undefined || stopped.outcome !== "succeeded",
        ).toBe(true);
        vi.spyOn(upstream, "getOpenCodeUpstreamBaseUrl").mockReturnValue(
          server.baseUrl,
        );
        const managerClient = client();
        sseAggregator.setPasswordResolver(() => password);
        sseAggregator.setPendingActionsFetcher({ api: managerClient.api });
        service = new ScheduleService(
          db,
          managerClient,
          new ScheduleWorktreeManager(new GitAuthService(), db),
        );
        sseAggregator.setScheduledSessionsResolver(
          () => service?.getActiveRunSessions() ?? [],
        );
        sseAggregator.start();
        await service.recoverRunningRuns();
        await expect
          .poll(() => getScheduleRunById(db, 1, job.id, run.id)?.status, {
            timeout: 20000,
          })
          .toBe("failed");
      expect(getScheduleRunById(db, 1, job.id, run.id)?.errorText).toBe(
        "Execution was interrupted repeatedly and will not be resumed automatically.",
      );
        expect(service.getActiveRunSessions()).toEqual([]);
        expect(await isActive()).toBe(false);
        process.stdout.write(
          `${JSON.stringify({ restartsBeforeStop: restarts, modelRequests: requests, errorText: getScheduleRunById(db, 1, job.id, run.id)?.errorText })}\n`,
        );
      } finally {
        sseAggregator.shutdown();
        sseAggregator.setPendingActionsFetcher(null);
        sseAggregator.setPasswordResolver(null);
        sseAggregator.setScheduledSessionsResolver(() => []);
        vi.restoreAllMocks();
        for (const response of open) response.destroy();
        llm.closeAllConnections();
        await new Promise<void>((resolve) => llm.close(() => resolve()));
        await server?.kill();
        db.close();
        await rm(directories.root, { recursive: true, force: true });
      }
    }, 300000);
  },
);
