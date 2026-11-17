import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareCutoverClaudeRefresh } from "../../../../bin/prepare-cutover-claude-refresh.mjs";

const state = vi.hoisted(() => ({
  mode: "",
  bootstrapCalls: 0,
  sourceChecks: 0,
  recoveryRecords: 0,
  recoveryReferences: 0,
}));
vi.mock("../../../../bin/operational-refresh-owner.mjs", () => ({
  assertOperationalRefreshOwnersStopped: async () => {},
}));
vi.mock("../../../../bin/operational-preparation-preflight.mjs", () => ({
  preflightOperationalPreparation: async () => {},
}));
vi.mock("../../src/services/claude-transfer-stage", async (original) => {
  const actual =
    await original<typeof import("../../src/services/claude-transfer-stage")>();
  return {
    ...actual,
    readPrivateTransferFile: async (path: string) =>
      path === "/Users/yeonghokim/apps/opencode-manager/.env"
        ? "fixture=1\n"
        : actual.readPrivateTransferFile(path),
  };
});
vi.mock("../../../../bin/read-openai-pool-plan.mjs", () => ({
  readOpenAiPoolPlan: async ({
    preserveRateLimits,
  }: {
    preserveRateLimits: boolean;
  }) => {
    expect(preserveRateLimits).toBe(true);
    if (state.mode === "invalid-plan")
      throw new Error("fixture-plan-unavailable");
    return {
      assertUnchanged: async () => {
        state.sourceChecks++;
        if (state.mode === "source-drift" && state.sourceChecks === 2)
          throw new Error("fixture-source-changed");
      },
    };
  },
}));
vi.mock("../../../../bin/bootstrap-operational-claude-refresh.mjs", () => ({
  bootstrapOperationalClaudeRefresh: async ({
    assertQuiescent,
  }: {
    assertQuiescent: () => Promise<void>;
  }) => {
    state.bootstrapCalls++;
    expect(state.recoveryRecords).toBe(1);
    expect(state.recoveryReferences).toBe(1);
    await assertQuiescent();
    return { path: "/fixture/identity.complete.json", sha256: "c".repeat(64) };
  },
}));
vi.mock("../../../../bin/record-claude-bootstrap-recovery.mjs", () => ({
  recordClaudeBootstrapRecovery: async () => {
    state.recoveryRecords++;
    if (state.mode === "record-failed")
      throw new Error("fixture-record-failed");
    return { path: "/fixture/recovery.json", sha256: "d".repeat(64) };
  },
}));

it.each([
  "valid",
  "invalid-plan",
  "source-drift",
  "record-failed",
  "reference-failed",
])(
  "checks the OpenAI plan before Claude bootstrap and retains the source guard for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-",
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    Object.assign(state, {
      mode,
      bootstrapCalls: 0,
      sourceChecks: 0,
      recoveryRecords: 0,
      recoveryReferences: 0,
    });
    try {
      const artifact = join(root, "fixture.json");
      await writeFile(artifact, "{}", { mode: 0o600 });
      const pin = { path: artifact, sha256: hash("{}") };
      const base = "/Users/yeonghokim/apps/ocm-v2-staging/run";
      const operation = prepareCutoverClaudeRefresh({
        preparation: {
          stateDirectory: root,
          environmentSha256: hash("fixture=1\n"),
          releaseManifest: pin,
          learningManifest: pin,
          learningConfiguration: pin,
          scheduleRoot: `${base}/learning-schedules-fixture`,
          claudeIdentities: {},
          dataPlan: {
            root: `${base}/stopped-data-fixture`,
            snapshotRoot: `${base}/oc1-migration-snapshot-fixture`,
            migrationRoot: `${base}/oc1-native-migration-fixture`,
            source:
              "/Users/yeonghokim/apps/opencode-manager/workspace/.opencode/state/opencode/opencode.db",
            openaiSource:
              "/Users/yeonghokim/.config/opencode-multi-auth/accounts.json",
            executionBudgetMs: 1800000,
          },
        },
        refreshPlan: {},
        operational: {
          recordBootstrapRecovery: async (reference: {
            path: string;
            sha256: string;
          }) => {
            expect(reference).toEqual({
              path: "/fixture/recovery.json",
              sha256: "d".repeat(64),
            });
            state.recoveryReferences++;
            if (mode === "reference-failed")
              throw new Error("fixture-reference-failed");
          },
        },
        assertQuiescent: async () => {},
        frontendContext: {},
        frontendRestore: {},
      });
      if (mode === "valid") {
        expect(await operation).toMatchObject({
          claudeIdentityReceipt: { path: "/fixture/identity.complete.json" },
        });
      } else if (mode === "invalid-plan") {
        await expect(operation).rejects.toThrow("fixture-plan-unavailable");
      } else if (mode === "record-failed") {
        await expect(operation).rejects.toThrow("fixture-record-failed");
      } else if (mode === "reference-failed") {
        await expect(operation).rejects.toThrow("fixture-reference-failed");
      } else {
        await expect(operation).rejects.toMatchObject({
          code: "CUTOVER_REFRESH_PREPARATION_UNVERIFIED",
          legacyRestartAllowed: false,
        });
      }
      expect(state.bootstrapCalls).toBe(
        ["invalid-plan", "record-failed", "reference-failed"].includes(mode)
          ? 0
          : 1,
      );
      expect(state.sourceChecks).toBe(
        mode === "invalid-plan"
          ? 0
          : ["record-failed", "reference-failed"].includes(mode)
            ? 1
            : 2,
      );
      expect(state.recoveryRecords).toBe(mode === "invalid-plan" ? 0 : 1);
      expect(state.recoveryReferences).toBe(
        mode === "invalid-plan" || mode === "record-failed" ? 0 : 1,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
