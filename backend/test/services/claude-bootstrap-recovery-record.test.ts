import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { recordClaudeBootstrapRecovery } from "../../../../bin/record-claude-bootstrap-recovery.mjs";

const state = vi.hoisted(() => ({ checks: 0, drift: false }));
vi.mock("../../../../bin/frontend-activation-binding.mjs", () => ({
  assertFrontendActivationBinding: async () => {
    state.checks++;
    return {
      path: "/fixture/frontend-scope.json",
      sha256:
        state.drift && state.checks === 2 ? "b".repeat(64) : "a".repeat(64),
    };
  },
}));
it.each([
  "recorded",
  "scope-drift",
  "directory-drift",
  "restore-hash-drift",
  "snapshot-bytes-drift",
])(
  "records only stable metadata before credential bootstrap for %s",
  async (mode) => {
    const root = await mkdtemp(
      "/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-",
    );
    Object.assign(state, { checks: 0, drift: mode === "scope-drift" });
    const pin = { path: "/fixture/reference.json", sha256: "a".repeat(64) };
    const base = "/Users/yeonghokim/apps/ocm-v2-staging/run";
    const definitionPath = join(root, "runtime.plist");
    const backendSnapshot = join(root, "backend-before.plist");
    const terminalSnapshot = join(root, "terminal-before.plist");
    const definitionBytes = "fixture-private-definition";
    const definitionSha256 = createHash("sha256")
      .update(definitionBytes)
      .digest("hex");
    const runtime = (label: string, port: number, registered: boolean) => ({
      label,
      port,
      registered,
      definition: definitionPath,
      definitionSha256,
      pids: [1234],
      expectedPID: 1234,
      expectedStarted: "fixture-start",
      stopScope: "owner",
      stopRequired: [{ pid: 1234, started: "fixture-start" }],
      survivingDescendants: 0,
      ignoredCredential: "must-not-be-recorded",
    });
    try {
      for (const path of [definitionPath, backendSnapshot, terminalSnapshot])
        await writeFile(path, definitionBytes, { mode: 0o600 });
      let quiescenceChecks = 0;
      const input = {
        preparation: {
          stateDirectory: root,
          environmentSha256: "a".repeat(64),
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
        refreshPlan: {
          root: `${base}/claude-refresh-fixture`,
          sourceSha256: "a".repeat(64),
        },
        operational: {
          externalUnit: `com.aion.ocm.cutover-${randomUUID()}`,
          restorePoint: {
            backend: {
              source: definitionPath,
              snapshot: backendSnapshot,
              sha256:
                mode === "restore-hash-drift"
                  ? "b".repeat(64)
                  : definitionSha256,
            },
            terminal: {
              source: definitionPath,
              snapshot: terminalSnapshot,
              sha256: definitionSha256,
            },
            backendStopRequested: true,
            terminalStopRequested: true,
          },
          units: [
            runtime("io.wineoflove.ocm.backend", 5101, false),
            runtime("io.wineoflove.ocm.terminal", 5104, false),
          ],
        },
        frontendContext: {
          frontend: runtime("io.wineoflove.ocm.frontend", 5173, true),
          gateway: runtime("com.aion.ocm.maintenance-ingress", 5141, true),
        },
        frontendRestore: {
          source: "/fixture/original.plist",
          snapshot: "/fixture/snapshot.plist",
          sha256: "a".repeat(64),
        },
        assertQuiescent: async () => {
          quiescenceChecks++;
          if (mode === "snapshot-bytes-drift" && quiescenceChecks === 2)
            await writeFile(backendSnapshot, "changed-definition", {
              mode: 0o600,
            });
          if (mode === "directory-drift" && quiescenceChecks === 2) {
            await rename(root, root + "-original");
            await mkdir(root, { mode: 0o700 });
          }
        },
      };
      const operation = recordClaudeBootstrapRecovery(input);
      const path = join(root, "claude-bootstrap-recovery.json");
      if (mode === "recorded") {
        const receipt = await operation;
        const text = await readFile(path, "utf8");
        expect(receipt).toEqual({
          path,
          sha256: createHash("sha256").update(text).digest("hex"),
        });
        expect(JSON.parse(text)).toMatchObject({
          phase: "before-claude-bootstrap",
          replayAllowed: false,
          legacyRestartAllowed: false,
          legacyRestore: input.operational.restorePoint,
        });
        expect(text).not.toContain("must-not-be-recorded");
        await expect(
          recordClaudeBootstrapRecovery(input),
        ).rejects.toMatchObject({ code: "EEXIST" });
        expect(await readFile(path, "utf8")).toBe(text);
      } else if (mode === "snapshot-bytes-drift") {
        await expect(operation).rejects.toMatchObject({
          code: "IDENTITY_CHANGED",
        });
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(operation).rejects.toThrow(
          mode === "directory-drift"
            ? "CLAUDE_BOOTSTRAP_RECOVERY_DIRECTORY_CHANGED"
            : mode === "restore-hash-drift"
              ? "CLAUDE_BOOTSTRAP_LEGACY_RESTORE_CHANGED"
              : "CLAUDE_BOOTSTRAP_RECOVERY_CONTEXT_CHANGED",
        );
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true });
      if (mode === "directory-drift")
        await rm(root + "-original", { recursive: true });
    }
  },
);
