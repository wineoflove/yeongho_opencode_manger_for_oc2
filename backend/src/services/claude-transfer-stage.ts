import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, mkdir, writeFile, rmdir, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  planClaudeTransfer,
  ClaudeTransferError,
  assertLegacyAuthMatchesPool,
} from "./claude-proxy-transfer";

const nativeAuth = z
  .object({
    anthropic: z
      .object({
        type: z.literal("oauth"),
        access: z.string(),
        refresh: z.string(),
        expires: z.number().finite(),
      })
      .passthrough(),
  })
  .passthrough();

export type ClaudeTransferStageInput = {
  readonly poolFile: string;
  readonly nativeAuthFile: string;
  readonly stagingDirectory: string;
  readonly identities: unknown;
  readonly expectedSourceSha256?: string;
  readonly assertQuiescent: () => Promise<void>;
  readonly nativeAuthMode?: "synchronize-main" | "preserve-anchor";
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function readPrivateTransferFile(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 1024 * 1024
    )
      throw new ClaudeTransferError("INVALID_INPUT");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function stageClaudeTransfer(input: ClaudeTransferStageInput) {
  if (
    ![input.poolFile, input.nativeAuthFile, input.stagingDirectory].every(
      isAbsolute,
    )
  )
    throw new ClaudeTransferError("INVALID_INPUT");
  await input.assertQuiescent();
  const lock = `${input.stagingDirectory}.lock`;
  await mkdir(lock, { mode: 0o700 });
  let owned = false;
  try {
    await mkdir(input.stagingDirectory, { mode: 0o700 });
    owned = true;
    await writeFile(
      join(input.stagingDirectory, "started.json"),
      JSON.stringify({ version: 1, phase: "staging", startedAt: Date.now() }),
      { mode: 0o600, flag: "wx" },
    );
    const source = await readPrivateTransferFile(input.poolFile);
    if (
      input.expectedSourceSha256 !== undefined &&
      hash(source) !== input.expectedSourceSha256
    )
      throw new ClaudeTransferError("SOURCE_CHANGED");
    const auth = await readPrivateTransferFile(input.nativeAuthFile);
    const authResult = nativeAuth.safeParse(JSON.parse(auth));
    if (!authResult.success) throw new ClaudeTransferError("INVALID_INPUT");
    const plan = planClaudeTransfer(source, input.identities);
    const nativeAuthMode = input.nativeAuthMode ?? "synchronize-main";
    if (!["synchronize-main", "preserve-anchor"].includes(nativeAuthMode))
      throw new ClaudeTransferError("INVALID_INPUT");
    if (nativeAuthMode === "synchronize-main")
      assertLegacyAuthMatchesPool(source, auth);
    await writeFile(join(input.stagingDirectory, "pool.before.json"), source, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(input.stagingDirectory, "auth.before.json"), auth, {
      mode: 0o600,
      flag: "wx",
    });
    const pending = join(input.stagingDirectory, "pending-auth");
    await mkdir(pending, { mode: 0o700 });
    for (const file of plan.files)
      await writeFile(join(pending, file.name), JSON.stringify(file.value), {
        mode: 0o600,
        flag: "wx",
      });
    await input.assertQuiescent();
    if (
      hash(await readPrivateTransferFile(input.poolFile)) !==
        plan.ledger.sourceSha256 ||
      hash(await readPrivateTransferFile(input.nativeAuthFile)) !== hash(auth)
    )
      throw new ClaudeTransferError("SOURCE_CHANGED");
    const ledger = {
      ...plan.ledger,
      nativeAuthSha256: hash(auth),
      nativeAuthMode,
      phase: "staged-not-activated",
      recordedAt: Date.now(),
    };
    await writeFile(
      join(input.stagingDirectory, "ledger.pending.json"),
      JSON.stringify(ledger),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await rename(
      join(input.stagingDirectory, "ledger.pending.json"),
      join(input.stagingDirectory, "ledger.json"),
    );
    return ledger;
  } catch (error) {
    if (owned)
      await writeFile(
        join(input.stagingDirectory, "failed.json"),
        JSON.stringify({
          phase: "failed",
          code:
            error instanceof ClaudeTransferError
              ? error.code
              : "STAGING_FAILED",
        }),
        { mode: 0o600, flag: "wx" },
      );
    throw error instanceof ClaudeTransferError
      ? error
      : new ClaudeTransferError("INVALID_INPUT");
  } finally {
    await rmdir(lock);
  }
}

export async function restoreNativeAnthropicAuth(
  original: string,
  restoredPool: string,
): Promise<string> {
  const originalValue = nativeAuth.safeParse(JSON.parse(original));
  const pool = z
    .object({
      accounts: z.array(z.object({ id: z.string(), credentials: z.unknown() })),
    })
    .safeParse(JSON.parse(restoredPool));
  if (!originalValue.success || !pool.success)
    throw new ClaudeTransferError("INVALID_INPUT");
  const main = pool.data.accounts.find((entry) => entry.id === "main");
  if (!main) throw new ClaudeTransferError("ACCOUNT_MISMATCH");
  const current = nativeAuth.shape.anthropic.safeParse(main.credentials);
  if (!current.success) throw new ClaudeTransferError("INVALID_INPUT");
  const updated = nativeAuth.safeParse({
    ...originalValue.data,
    anthropic: { ...originalValue.data.anthropic, ...current.data },
  });
  if (!updated.success) throw new ClaudeTransferError("INVALID_INPUT");
  return JSON.stringify(updated.data);
}
