import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { claudeActivationCutoverStep } from "../../src/services/cutover-claude-activation-step";
import { ClaudeProxyGate } from "../../src/services/claude-proxy-gate";

it.each([
  "normal",
  "missing-receipt",
  "archive-only",
  "foreign-target",
  "foreign-before",
  "foreign-after",
])(
  "recovers owned Claude activation state %s without changing the native anchor",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "claude-step-"));
    try {
      const credentials = {
        type: "oauth",
        access: "synthetic-old",
        refresh: "synthetic-refresh",
        expires: Date.now() + 7200000,
      };
      const pool = {
        version: 1,
        cursor: 0,
        paused: false,
        blockedRequests: [],
        accounts: [
          {
            id: "main",
            label: "synthetic",
            enabled: true,
            status: "ok",
            cooldownUntil: 0,
            credentials,
          },
        ],
      };
      const poolFile = join(root, "pool.json");
      const nativeAuthFile = join(root, "auth.json");
      const stagingDirectory = join(root, "stage");
      const targetAuthDirectory = join(root, "target");
      const gateDirectory = join(root, "gate");
      const anchor = JSON.stringify({
        anthropic: { ...credentials, access: "synthetic-anchor" },
      });
      await writeFile(poolFile, JSON.stringify(pool), { mode: 0o600 });
      await writeFile(nativeAuthFile, anchor, { mode: 0o600 });
      await mkdir(targetAuthDirectory, { mode: 0o700 });
      await ClaudeProxyGate.initialize(gateDirectory);
      let checks = 0;
      const step = claudeActivationCutoverStep({
        staging: {
          poolFile,
          nativeAuthFile,
          stagingDirectory,
          identities: { main: "00000000-0000-4000-8000-000000000001" },
          assertQuiescent: async () => {
            if (++checks === 3 && mode === "foreign-before") {
              await rename(targetAuthDirectory, join(root, "original-target"));
              await mkdir(targetAuthDirectory, { mode: 0o700 });
            }
            if (checks === 5 && mode === "foreign-after")
              await mkdir(targetAuthDirectory, { mode: 0o700 });
          },
        },
        targetAuthDirectory,
        gateDirectory,
      });
      if (mode === "foreign-before" || mode === "foreign-after") {
        await expect(step.forward()).rejects.toThrow();
        expect(await readdir(targetAuthDirectory)).toEqual([]);
        if (mode === "foreign-before")
          expect(await readdir(stagingDirectory)).not.toContain(
            "auth-directory.before",
          );
        else
          expect(await readdir(stagingDirectory)).toContain(
            "auth-directory.before",
          );
        expect(await readFile(poolFile, "utf8")).toBe(JSON.stringify(pool));
        return;
      }
      await step.forward();
      switch (mode) {
        case "normal":
        case "missing-receipt": {
          const file = join(targetAuthDirectory, "legacy-main.json");
          const current = JSON.parse(await readFile(file, "utf8"));
          await writeFile(
            file,
            JSON.stringify({ ...current, refresh_token: "synthetic-latest" }),
          );
          if (mode === "missing-receipt")
            await unlink(join(stagingDirectory, "activation-installed.json"));
          break;
        }
        case "archive-only":
          await rename(
            targetAuthDirectory,
            join(stagingDirectory, "pending-auth"),
          );
          await unlink(join(stagingDirectory, "activation-installed.json"));
          break;
        case "foreign-target":
          await rename(targetAuthDirectory, join(root, "owned-target"));
          await mkdir(targetAuthDirectory, { mode: 0o700 });
          break;
      }
      if (mode === "foreign-target") {
        await expect(step.rollback()).rejects.toThrow(
          "CLAUDE_ACTIVATION_OWNERSHIP_UNVERIFIED",
        );
        expect(await readFile(poolFile, "utf8")).toBe(JSON.stringify(pool));
      } else {
        await step.rollback();
        await step.rollback();
        expect(
          JSON.parse(await readFile(poolFile, "utf8")).accounts[0].credentials
            .refresh,
        ).toBe(
          mode === "archive-only" ? credentials.refresh : "synthetic-latest",
        );
      }
      expect(await readFile(nativeAuthFile, "utf8")).toBe(anchor);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
