import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSupervisedCutoverJob } from "../../../../bin/run-supervised-cutover-job.mjs";

const state = vi.hoisted(() => ({
  service: "",
  mode: "",
  registered: false,
  bootstraps: 0,
  bootouts: 0,
  polls: 0,
  supervised: false,
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_file: string, args: string[]) => {
    if (args[0] === "bootstrap") {
      state.bootstraps++;
      if (state.mode === "bootstrap-failed")
        return { status: 1, stdout: "", stderr: "fixture-failure" };
      state.registered = true;
      if (state.mode === "partial-bootstrap")
        return { status: 1, stdout: "", stderr: "fixture-response-failure" };
    }
    if (args[0] === "bootout") {
      state.bootouts++;
      state.registered = false;
    }
    return { status: 0, stdout: "", stderr: "" };
  }),
}));
vi.mock("../../../../bin/inspect-external-cutover-job.mjs", () => ({
  inspectExternalCutoverJob: async () => {
    if (!state.registered) return { state: "absent", service: state.service };
    if (state.supervised)
      return {
        state: "exited-report-unattributed",
        attemptBindingVerified: true,
      };
    state.polls++;
    if (state.mode === "startup-pending" && state.polls === 1)
      return { state: "unknown" };
    return {
      state: "running",
      identity: { pid: 1234, started: "fixture-start" },
    };
  },
}));
vi.mock("../../../../bin/supervise-external-cutover-job.mjs", () => ({
  superviseExternalCutoverJob: async () => {
    if (state.mode === "supervision-failed")
      throw new Error("fixture-supervision-failure");
    state.supervised = true;
    return {
      identity: {
        pid: state.mode === "replacement" ? 5678 : 1234,
        started: "fixture-start",
      },
    };
  },
}));
vi.mock("../../src/services/claude-transfer-quiescence", () => ({
  captureProcessIdentities: () => [],
}));
vi.mock("../../../../bin/assert-synthetic-cutover-launch.mjs", () => ({
  assertSyntheticCutoverLaunch: ({
    readyToLaunch,
  }: {
    readyToLaunch: boolean;
  }) => {
    if (!readyToLaunch) throw new Error("CUTOVER_LAUNCH_READINESS_REQUIRED");
  },
}));

it.each([
  "completed",
  "startup-pending",
  "not-ready",
  "definition-changed",
  "bootstrap-failed",
  "partial-bootstrap",
  "supervision-failed",
  "replacement",
])(
  "requires launch readiness and preserves uncertain execution for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/prepared-cutover-job-",
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    Object.assign(state, {
      service: `gui/${process.getuid?.()}/com.aion.ocm.cutover-${randomUUID()}`,
      mode,
      registered: false,
      bootstraps: 0,
      bootouts: 0,
      polls: 0,
      supervised: false,
    });
    try {
      const definition = join(root, "job.plist");
      await writeFile(definition, "fixture-definition", { mode: 0o600 });
      for (const name of ["stdout.json", "stderr.log"])
        await writeFile(join(root, name), "", { mode: 0o600 });
      const text = JSON.stringify({
        root,
        label: state.service.split("/").at(-1),
        service: state.service,
        definition: { path: definition, sha256: hash("fixture-definition") },
        readyToLaunch: mode !== "not-ready",
      });
      await writeFile(join(root, "report.json"), text, { mode: 0o600 });
      let checks = 0;
      const operation = runSupervisedCutoverJob({
        root,
        reportSha256: hash(text),
        timeoutMs: 1000,
        assertReady: async () => {
          checks++;
          if (checks === 2 && mode === "definition-changed")
            await writeFile(definition, "foreign-definition", { mode: 0o600 });
          if (checks === 2 && mode !== "definition-changed")
            await writeFile(join(root, "attempt.json"), "{}", { mode: 0o600 });
        },
      });
      if (mode === "completed" || mode === "startup-pending") {
        expect(await operation).toMatchObject({
          state: "supervised-job-ended-cleanup-pending",
          registrationRemoved: false,
          cleanupAllowed: false,
          operationalSuccessVerified: false,
        });
        expect(state.bootouts).toBe(0);
        expect(state.registered).toBe(true);
      } else {
        await expect(operation).rejects.toBeInstanceOf(Error);
        expect(state.bootouts).toBe(0);
        await expect(
          readFile(join(root, "supervised-job-result.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(state.bootstraps).toBe(
        mode === "not-ready" || mode === "definition-changed" ? 0 : 1,
      );
      if (mode === "not-ready") expect(checks).toBe(0);
      if (
        mode === "supervision-failed" ||
        mode === "replacement" ||
        mode === "partial-bootstrap"
      )
        expect(state.registered).toBe(true);
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
