import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { automaticRefreshFixture } from "../../../../bin/automatic-refresh.fixture.mjs";
import { readClaudeBootstrapRecovery } from "../../../../bin/read-claude-bootstrap-recovery.mjs";
import { planClaimedRefreshFiles } from "../../../../bin/claimed-refresh-return-plan.mjs";

const state = vi.hoisted(() => ({ source: "", swapped: false }));
vi.mock(
  "../../../../bin/inspect-automatic-refresh-state.mjs",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../../bin/inspect-automatic-refresh-state.mjs")
      >();
    return {
      ...actual,
      inspectAutomaticRefreshState: async (root: string) => {
        const replacement =
          (await readFile(join(root, "source.original.json"), "utf8")) + "\n";
        const plan = planClaimedRefreshFiles(replacement);
        await writeFile(state.source, replacement, { mode: 0o600 });
        await writeFile(join(root, "source.original.json"), replacement, {
          mode: 0o600,
        });
        await writeFile(
          join(root, "stage.json"),
          JSON.stringify({
            version: 1,
            source: state.source,
            sourceSha256: plan.sourceSha256,
            files: plan.files.map(
              (file: {
                sourceID: string;
                fileName: string;
                sha256: string;
              }) => ({
                sourceID: file.sourceID,
                fileName: file.fileName,
                sha256: file.sha256,
              }),
            ),
            nativeAnchorTouched: false,
          }),
          { mode: 0o600 },
        );
        state.swapped = true;
        return actual.inspectAutomaticRefreshState(root);
      },
    };
  },
);

it("rejects internally consistent evidence replaced after the pinned original was checked", async () => {
  const fixture = await automaticRefreshFixture();
  const directory = await mkdtemp(
    "/Users/yeonghokim/apps/ocm-v2-staging/run/learning-transition-",
  );
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const base = "/Users/yeonghokim/apps/ocm-v2-staging/run";
  const pin = {
    path: join(directory, "reference.json"),
    sha256: "a".repeat(64),
  };
  state.source = fixture.source;
  state.swapped = false;
  try {
    const text = JSON.stringify({
      version: 1,
      phase: "before-claude-bootstrap",
      preparation: {
        stateDirectory: directory,
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
      refresh: { root: fixture.root, sourceSha256: hash(fixture.original) },
      replayAllowed: false,
      legacyRestartAllowed: false,
    });
    const path = join(directory, "claude-bootstrap-recovery.json");
    await writeFile(path, text, { mode: 0o600 });
    await expect(
      readClaudeBootstrapRecovery({ path, sha256: hash(text) }),
    ).rejects.toThrow("BOOTSTRAP_RECOVERY_SOURCE_CHANGED");
    expect(state.swapped).toBe(true);
    expect(await readFile(path, "utf8")).toBe(text);
  } finally {
    await rm(fixture.root, { recursive: true });
    await rm(fixture.sourceRoot, { recursive: true });
    await rm(directory, { recursive: true });
  }
});
