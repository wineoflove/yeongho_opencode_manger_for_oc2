import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLearningsEntriesPath } from "@opencode-manager/shared/config/env";

describe("learning entries configuration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "learnings-env-"));
    vi.stubEnv("WORKSPACE_PATH", join(root, "workspace"));
    vi.stubEnv("OCM_LEARNINGS_ENTRIES_PATH", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses workspace learning entries when the override is absent", () => {
    expect(getLearningsEntriesPath()).toBe(
      join(root, "workspace", ".opencode", "learnings", "entries"),
    );
  });

  it.each(["absolute", "relative"] as const)(
    "resolves an %s override instead of workspace entries",
    (kind) => {
      const entries = join(root, "canonical", "entries");
      vi.stubEnv(
        "OCM_LEARNINGS_ENTRIES_PATH",
        kind === "absolute" ? entries : relative(process.cwd(), entries),
      );

      expect(getLearningsEntriesPath()).toBe(entries);
    },
  );
});
