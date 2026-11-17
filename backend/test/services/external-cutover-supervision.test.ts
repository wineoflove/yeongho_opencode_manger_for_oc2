import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { superviseExternalCutoverJob } from "../../../../bin/supervise-external-cutover-job.mjs";

const state = vi.hoisted(() => ({ calls: 0, mode: "", resultRoot: "" }));
vi.mock("../../../../bin/inspect-external-cutover-job.mjs", () => ({
  inspectExternalCutoverJob: async () => {
    state.calls++;
    if (state.calls <= 2)
      return {
        state: "running",
        identity: {
          pid: state.mode === "replacement" && state.calls === 2 ? 5678 : 1234,
          started: "observed-start",
        },
      };
    return {
      state: "exited-report-unattributed",
      attemptBindingVerified: true,
      resultRoot:
        state.mode === "foreign-result"
          ? state.resultRoot + "other"
          : state.resultRoot,
      result: "blocked",
    };
  },
}));
vi.mock("../../src/services/claude-transfer-quiescence", () => ({
  captureProcessIdentities: () =>
    state.mode === "still-running"
      ? [{ pid: 1234, started: "observed-start" }]
      : [],
}));

it.each(["observed", "replacement", "foreign-result", "still-running"])(
  "records only the witnessed execution result for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/prepared-cutover-job-",
    );
    const resultRoot = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/external-frontend-maintenance-",
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    state.mode = mode;
    state.calls = 0;
    state.resultRoot = resultRoot;
    try {
      const label = `com.aion.ocm.cutover-${randomUUID()}`;
      const runID = randomUUID();
      const input = { path: join(root, "input.json"), sha256: "a".repeat(64) };
      const executionManifest = {
        path: join(root, "execution-manifest.json"),
        sha256: "b".repeat(64),
      };
      const bindingText = JSON.stringify({
        version: 1,
        runID,
        label,
        input,
        executionManifest,
      });
      const binding = {
        path: join(root, "binding.json"),
        sha256: hash(bindingText),
      };
      await writeFile(binding.path, bindingText, { mode: 0o600 });
      const reportText = JSON.stringify({
        label,
        binding,
        input,
        executionManifest,
      });
      await writeFile(join(root, "report.json"), reportText, { mode: 0o600 });
      const identity = { pid: 1234, started: "observed-start" };
      const attemptText = JSON.stringify({
        version: 1,
        runID,
        label,
        binding,
        input,
        executionManifest,
        identity,
        resultRoot,
      });
      const jobAttempt = {
        path: join(root, "attempt.json"),
        sha256: hash(attemptText),
      };
      await writeFile(jobAttempt.path, attemptText, { mode: 0o600 });
      await writeFile(
        join(resultRoot, "report.json"),
        JSON.stringify({ root: resultRoot, jobAttempt, result: "blocked" }),
        { mode: 0o600 },
      );
      const operation = superviseExternalCutoverJob({
        root,
        reportSha256: hash(reportText),
        timeoutMs: 1000,
      });
      if (mode === "observed") {
        expect(await operation).toMatchObject({
          state: "observed-execution-result-recorded",
          identity,
          observedExecutionResultVerified: true,
          currentRegistrationGenerationVerified: false,
          exitCodeVerified: false,
          operationalSuccessVerified: false,
          cleanupAllowed: false,
        });
        expect(
          JSON.parse(
            await readFile(join(root, "supervision-result.json"), "utf8"),
          ).result.reportedResult,
        ).toBe("blocked");
      } else {
        await expect(operation).rejects.toThrow(
          mode === "replacement"
            ? "CUTOVER_SUPERVISION_PROCESS_CHANGED"
            : mode === "still-running"
              ? "CUTOVER_SUPERVISION_PROCESS_PRESENT"
              : "CUTOVER_SUPERVISION_RESULT_UNVERIFIED",
        );
        await expect(
          readFile(join(root, "supervision-result.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true });
      await rm(resultRoot, { recursive: true });
    }
  },
);
