import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareCutoverLaunchReadiness,
  assertCutoverLaunchReadiness,
} from "../../../../bin/cutover-launch-readiness.mjs";

const state = vi.hoisted(() => ({ root: "", failed: false, inspections: 0 }));
vi.mock("../../../../bin/assert-external-executor-pins.mjs", () => ({
  assertExternalExecutorPins: async () => {},
}));
vi.mock("../../../../bin/inspect-prepared-cutover-input.mjs", () => ({
  inspectPreparedCutoverInput: async () => {
    state.inspections++;
    const evidencePath = join(state.root, `inspection-${randomUUID()}.json`);
    await writeFile(
      evidencePath,
      JSON.stringify({
        result: state.failed
          ? "blocked"
          : "static-inputs-verified-not-ready-to-launch",
      }),
      { mode: 0o600 },
    );
    return {
      evidencePath,
      result: state.failed
        ? "blocked"
        : "static-inputs-verified-not-ready-to-launch",
    };
  },
}));

it.each([
  "valid",
  "expired",
  "supervisor-changed",
  "wrong-supervisor",
  "job-changed",
  "static-failed",
  "inspection-changed",
])(
  "binds launch readiness to fresh static evidence and the supervisor for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/prepared-cutover-job-",
    );
    const supervisorRoot = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/cutover-supervisor-",
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    Object.assign(state, { root, failed: false, inspections: 0 });
    const put = async (path: string, value: string) => {
      await writeFile(path, value, { mode: 0o600 });
      return { path, sha256: hash(value) };
    };
    try {
      const supervisor = await put(
        join(supervisorRoot, "supervisor.js"),
        "fixture-supervisor",
      );
      const input = await put(join(root, "input.json"), "{}");
      const definition = await put(
        join(root, "job.plist"),
        "fixture-definition",
      );
      const binding = await put(join(root, "binding.json"), "{}");
      const executorReport = await put(
        join(root, "executor-report.json"),
        JSON.stringify({ executor: { path: "/fixture/executor.js" } }),
      );
      const executionManifest = await put(
        join(root, "execution-manifest.json"),
        "{}",
      );
      const report = JSON.stringify({
        root,
        result: "external-cutover-job-prepared-not-registered",
        readyToLaunch: false,
        input,
        definition,
        binding,
        executorReport,
        executionManifest,
      });
      await writeFile(join(root, "report.json"), report, { mode: 0o600 });
      const reportSha256 = hash(report);
      const readiness = await prepareCutoverLaunchReadiness({
        root,
        reportSha256,
        supervisor,
      });
      const originalReadiness = await readFile(readiness.path, "utf8");
      const record = JSON.parse(originalReadiness);
      if (mode === "expired") {
        const expired = JSON.stringify({
          ...record,
          issuedAt: 1,
          expiresAt: 2,
        });
        await writeFile(readiness.path, expired, { mode: 0o600 });
        readiness.sha256 = hash(expired);
      }
      if (mode === "supervisor-changed")
        await writeFile(supervisor.path, "changed", { mode: 0o600 });
      if (mode === "job-changed")
        await writeFile(join(root, "report.json"), report + " ", {
          mode: 0o600,
        });
      if (mode === "inspection-changed")
        await writeFile(record.inspection.path, "changed", { mode: 0o600 });
      if (mode === "static-failed") state.failed = true;
      const operation = assertCutoverLaunchReadiness({
        root,
        reportSha256,
        readiness,
        executingSupervisor:
          mode === "wrong-supervisor"
            ? "/foreign/supervisor.js"
            : supervisor.path,
      });
      if (mode === "valid") {
        await expect(operation).resolves.toBeUndefined();
        expect(state.inspections).toBe(2);
        expect(
          JSON.parse(await readFile(join(root, "report.json"), "utf8"))
            .readyToLaunch,
        ).toBe(false);
      } else await expect(operation).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(root, { recursive: true });
      await rm(supervisorRoot, { recursive: true });
    }
  },
);
