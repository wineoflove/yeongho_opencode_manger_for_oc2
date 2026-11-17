import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  stageClaudeTransfer,
  restoreNativeAnthropicAuth,
} from "../../src/services/claude-transfer-stage";

const credential = {
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: 1800000000000,
};
const pool = {
  version: 1,
  cursor: 0,
  paused: false,
  blockedRequests: [],
  accounts: [
    {
      id: "main",
      label: "Primary",
      enabled: true,
      status: "ok",
      cooldownUntil: 0,
      credentials: credential,
    },
  ],
};
const auth = {
  anthropic: credential,
  openai: { type: "oauth", access: "other-provider-access" },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "transfer-stage-"));
  const poolFile = join(root, "pool.json");
  const nativeAuthFile = join(root, "auth.json");
  await writeFile(poolFile, JSON.stringify(pool), { mode: 0o600 });
  await writeFile(nativeAuthFile, JSON.stringify(auth), { mode: 0o600 });
  return {
    root,
    poolFile,
    nativeAuthFile,
    stagingDirectory: join(root, "transfer"),
    identities: { main: "00000000-0000-4000-8000-000000000001" },
  };
}

describe("offline credential staging", () => {
  it("rejects credentials changed after identity verification before copying them", async () => {
    const input = await fixture();
    try {
      const expectedSourceSha256 = createHash("sha256")
        .update(JSON.stringify(pool))
        .digest("hex");
      const changed = {
        ...pool,
        accounts: pool.accounts.map((account) => ({
          ...account,
          credentials: { ...credential, access: "changed-generation" },
        })),
      };
      await writeFile(input.poolFile, JSON.stringify(changed), { mode: 0o600 });
      await expect(
        stageClaudeTransfer({
          ...input,
          expectedSourceSha256,
          nativeAuthMode: "preserve-anchor",
          assertQuiescent: async () => {},
        }),
      ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(await readdir(input.stagingDirectory)).not.toContain(
        "pool.before.json",
      );
      expect(await readFile(input.poolFile, "utf8")).toBe(
        JSON.stringify(changed),
      );
    } finally {
      await rm(input.root, { recursive: true });
    }
  });

  it("rejects a different main token generation in native auth before staging credentials", async () => {
    const input = await fixture();
    try {
      await writeFile(
        input.nativeAuthFile,
        JSON.stringify({
          ...auth,
          anthropic: { ...credential, refresh: "different-generation" },
        }),
      );
      await expect(
        stageClaudeTransfer({ ...input, assertQuiescent: async () => {} }),
      ).rejects.toMatchObject({
        code: "ACCOUNT_MISMATCH",
      });
      expect(await readdir(input.stagingDirectory)).not.toContain(
        "ledger.json",
      );
    } finally {
      await rm(input.root, { recursive: true });
    }
  });
  it("stages private copies without changing either original and refuses overwrite", async () => {
    const input = await fixture();
    try {
      let guards = 0;
      const options = {
        ...input,
        assertQuiescent: async () => {
          guards++;
        },
      };
      const ledger = await stageClaudeTransfer(options);
      expect(guards).toBe(2);
      expect(ledger.phase).toBe("staged-not-activated");
      expect(await readFile(input.poolFile, "utf8")).toBe(JSON.stringify(pool));
      expect(await readFile(input.nativeAuthFile, "utf8")).toBe(
        JSON.stringify(auth),
      );
      expect(
        await readdir(join(input.stagingDirectory, "pending-auth")),
      ).toEqual(["legacy-main.json"]);
      await expect(stageClaudeTransfer(options)).rejects.toThrow();
      expect(
        JSON.parse(
          await readFile(join(input.stagingDirectory, "ledger.json"), "utf8"),
        ),
      ).toEqual(ledger);
    } finally {
      await rm(input.root, { recursive: true });
    }
  });

  it("does not create staging files when quiescence is unproven", async () => {
    const input = await fixture();
    try {
      await expect(
        stageClaudeTransfer({
          ...input,
          assertQuiescent: async () => {
            throw new Error("busy");
          },
        }),
      ).rejects.toThrow("busy");
      expect((await readdir(input.root)).sort()).toEqual([
        "auth.json",
        "pool.json",
      ]);
    } finally {
      await rm(input.root, { recursive: true });
    }
  });

  it("records a failed attempt instead of publishing a ledger when the source changes", async () => {
    const input = await fixture();
    try {
      let calls = 0;
      await expect(
        stageClaudeTransfer({
          ...input,
          assertQuiescent: async () => {
            if (++calls === 2)
              await writeFile(
                input.poolFile,
                JSON.stringify({ ...pool, cursor: 1 }),
              );
          },
        }),
      ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(await readdir(input.stagingDirectory)).not.toContain(
        "ledger.json",
      );
      expect(
        JSON.parse(
          await readFile(join(input.stagingDirectory, "failed.json"), "utf8"),
        ),
      ).toEqual({
        phase: "failed",
        code: "SOURCE_CHANGED",
      });
    } finally {
      await rm(input.root, { recursive: true });
    }
  });

  it("restores the latest main token in native auth while retaining other providers", async () => {
    const latest = {
      ...credential,
      access: "updated-access",
      refresh: "updated-refresh",
    };
    const result = await restoreNativeAnthropicAuth(
      JSON.stringify(auth),
      JSON.stringify({ accounts: [{ id: "main", credentials: latest }] }),
    );
    expect(JSON.parse(result)).toEqual({ ...auth, anthropic: latest });
    const extended = {
      ...auth,
      anthropic: { ...credential, accountLabel: "preserve-metadata" },
    };
    const preserved = await restoreNativeAnthropicAuth(
      JSON.stringify(extended),
      JSON.stringify({ accounts: [{ id: "main", credentials: latest }] }),
    );
    expect(JSON.parse(preserved).anthropic.accountLabel).toBe(
      "preserve-metadata",
    );
  });
});
