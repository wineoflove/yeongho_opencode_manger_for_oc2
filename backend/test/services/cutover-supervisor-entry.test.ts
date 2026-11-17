import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCutoverSupervisor } from "../../../../bin/run-cutover-supervisor.mjs";

const state = vi.hoisted(() => ({
  root: "",
  mode: "",
  launches: 0,
  readinessChecks: 0,
}));
vi.mock("node:child_process", () => ({
  spawnSync: () => ({
    status: 0,
    stdout: `path = ${state.root}/supervisor.plist\npid = ${state.mode === "wrong-owner" ? process.pid + 1 : process.pid}\n`,
    stderr: "",
  }),
}));
vi.mock("../../../../bin/cutover-launch-readiness.mjs", () => ({
  prepareCutoverLaunchReadiness: async () => {
    state.readinessChecks++;
    if (state.mode === "readiness-failed")
      throw new Error("READINESS_STATIC_CHECK_FAILED");
    return { path: "/fixture/readiness.json", sha256: "b".repeat(64) };
  },
}));
vi.mock("../../../../bin/run-supervised-cutover-job.mjs", () => ({
  runSupervisedCutoverJob: async ({
    assertReady,
  }: {
    assertReady: () => Promise<void>;
  }) => {
    await assertReady();
    state.launches++;
    if (
      state.mode === "launch-failed" ||
      state.mode === "failure-record-failed"
    )
      throw new Error("CUTOVER_SUPERVISED_BOOTSTRAP_UNVERIFIED");
    return {
      state: "supervised-job-ended-cleanup-pending",
      registrationRemoved: false,
      operationalSuccessVerified: false,
    };
  },
}));
vi.mock("../../../../bin/inspect-external-cutover-job.mjs", () => ({
  inspectExternalCutoverJob: async () => ({
    state: state.launches ? "unknown" : "absent",
  }),
}));
vi.mock("../../src/services/claude-transfer-activate", async (original) => {
  const actual =
    await original<
      typeof import("../../src/services/claude-transfer-activate")
    >();
  return {
    ...actual,
    durableTransferRecord: async (path: string, record: unknown) => {
      if (
        state.mode === "result-record-failed" &&
        path.endsWith("/supervisor-result.json")
      )
        throw new Error("RESULT_PUBLICATION_FAILED");
      if (
        state.mode === "failure-record-failed" &&
        path.includes("/supervisor-failure-")
      )
        throw new Error("FAILURE_PUBLICATION_FAILED");
      return actual.durableTransferRecord(path, record);
    },
  };
});

it.each([
  "observed",
  "wrong-owner",
  "readiness-failed",
  "launch-failed",
  "result-record-failed",
  "failure-record-failed",
])(
  "records bounded supervisor outcomes without claiming operational success for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/cutover-supervisor-",
    );
    Object.assign(state, { root, mode, launches: 0, readinessChecks: 0 });
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    try {
      const executingSupervisor = join(root, "supervisor.js");
      await writeFile(executingSupervisor, "fixture", { mode: 0o600 });
      const request = JSON.stringify({
        version: 1,
        label: `com.aion.ocm.supervisor-${randomUUID()}`,
        job: {
          root: "/Users/yeonghokim/apps/ocm-v2-staging/run/prepared-cutover-job-fixture",
          reportSha256: "a".repeat(64),
        },
        supervisor: { path: executingSupervisor, sha256: hash("fixture") },
        timeoutMs: 1000,
      });
      const requestPath = join(root, "request.json");
      await writeFile(requestPath, request, { mode: 0o600 });
      const result = await runCutoverSupervisor({
        requestPath,
        requestSha256: hash(request),
        executingSupervisor,
      });
      expect(result).toMatchObject({
        operationalSuccessVerified: false,
        cleanupAllowed: false,
      });
      if (mode === "observed") {
        expect(result.state).toBe("observed-job-result");
        expect(
          JSON.parse(
            await readFile(join(root, "supervisor-result.json"), "utf8"),
          ).state,
        ).toBe("observed-job-result");
      } else {
        expect(result).toMatchObject({
          state: "supervisor-failed",
          failureRecorded: mode !== "failure-record-failed",
        });
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith("supervisor-failure-"),
          ),
        ).toHaveLength(mode === "failure-record-failed" ? 0 : 1);
        await expect(
          readFile(join(root, "supervisor-result.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(state.launches).toBe(
        mode === "wrong-owner" || mode === "readiness-failed" ? 0 : 1,
      );
      expect(state.readinessChecks).toBe(mode === "wrong-owner" ? 0 : 1);
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
