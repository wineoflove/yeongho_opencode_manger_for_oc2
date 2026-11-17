import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectExternalCutoverJob } from "../../../../bin/inspect-external-cutover-job.mjs";
import { claimCutoverJobAttempt } from "../../../../bin/claim-cutover-job-attempt.mjs";

const state = vi.hoisted(() => ({
  definition: "",
  mode: "",
  prints: 0,
  identityReads: 0,
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => {
    state.prints++;
    const pid = state.mode === "pid-changed" && state.prints > 1 ? 2345 : 1234;
    return {
      pid: 0,
      status: 0,
      signal: null,
      output: [],
      stderr: "",
      stdout: `path = ${state.definition}\nruns = 1\n${state.mode.startsWith("old-") ? "last exit code = 1" : `pid = ${pid}`}\n`,
    };
  }),
}));
vi.mock("../../src/services/claude-transfer-quiescence", () => ({
  captureProcessIdentities: () => {
    state.identityReads++;
    return [
      {
        pid: 1234,
        started:
          state.mode === "start-changed" && state.identityReads > 1
            ? "replacement"
            : "original",
      },
    ];
  },
}));

it.each([
  "running",
  "pid-changed",
  "start-changed",
  "old-report",
  "old-unbound-recovery",
  "old-bound-report",
])(
  "keeps process observation and result attribution distinct for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/prepared-cutover-job-",
    );
    const resultRoot = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/external-frontend-maintenance-",
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    state.definition = join(root, "job.plist");
    state.mode = mode;
    state.prints = 0;
    state.identityReads = 0;
    try {
      await writeFile(state.definition, "fixture", { mode: 0o600 });
      const label = `com.aion.ocm.cutover-${randomUUID()}`;
      const input = { path: join(root, "input.json"), sha256: "a".repeat(64) };
      const executionManifest = {
        path: join(root, "execution-manifest.json"),
        sha256: "b".repeat(64),
      };
      const bindingText = JSON.stringify({
        version: 1,
        runID: randomUUID(),
        label,
        input,
        executionManifest,
      });
      const binding = {
        path: join(root, "binding.json"),
        sha256: hash(bindingText),
      };
      await writeFile(binding.path, bindingText, { mode: 0o600 });
      const jobAttempt =
        mode === "old-bound-report"
          ? await claimCutoverJobAttempt({
              binding,
              externalUnit: label,
              resultRoot,
              input,
              executionManifest,
            })
          : undefined;
      const report = JSON.stringify({
        root,
        result: "external-cutover-job-prepared-not-registered",
        label,
        service: `gui/${process.getuid?.()}/${label}`,
        definition: { path: state.definition, sha256: hash("fixture") },
        ...(jobAttempt ? { binding, input, executionManifest } : {}),
      });
      await writeFile(join(root, "report.json"), report, { mode: 0o600 });
      const previous = JSON.stringify({
        root: resultRoot,
        mode: "--activate",
        result: "activation-committed-periodic-registration-verified",
        serviceActionsRequested: true,
        ...(mode === "old-unbound-recovery"
          ? {
              runtime: {
                claudeBootstrapRecovery: {
                  path: "/must-not-read/recovery.json",
                  sha256: "a".repeat(64),
                },
              },
            }
          : {}),
        ...(jobAttempt ? { jobAttempt } : {}),
      });
      await writeFile(join(root, "stdout.json"), previous, { mode: 0o600 });
      await writeFile(join(resultRoot, "report.json"), previous, {
        mode: 0o600,
      });
      const operation = inspectExternalCutoverJob({
        root,
        reportSha256: hash(report),
      });
      if (mode === "pid-changed" || mode === "start-changed") {
        await expect(operation).rejects.toThrow(
          "CUTOVER_JOB_PROCESS_UNVERIFIED",
        );
      } else {
        expect(await operation).toMatchObject({
          state: mode === "running" ? "running" : "exited-report-unattributed",
          operationalSuccessVerified: false,
          resultAttributionVerified: false,
          cleanupAllowed: false,
          ...(mode === "old-unbound-recovery"
            ? {
                bootstrapRecovery: {
                  state: "bootstrap-recovery-unverified",
                  executionAuthorized: false,
                },
              }
            : {}),
          ...(mode.startsWith("old-")
            ? {
                exitCode: 1,
                reportFilesMatch: true,
                attemptBindingVerified: mode === "old-bound-report",
                registrationGenerationVerified: false,
              }
            : { identity: { pid: 1234, started: "original" } }),
        });
      }
    } finally {
      await rm(root, { recursive: true });
      await rm(resultRoot, { recursive: true });
    }
  },
);
