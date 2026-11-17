import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  planClaudeTransfer,
  ClaudeTransferError,
  assertLegacyAuthMatchesPool,
} from "./claude-proxy-transfer";
import { readPrivateTransferFile } from "./claude-transfer-stage";

const ledgerSchema = z.object({
  version: z.literal(1),
  phase: z.literal("staged-not-activated"),
  sourceSha256: z.string(),
  nativeAuthSha256: z.string(),
  nativeAuthMode: z
    .enum(["synchronize-main", "preserve-anchor"])
    .default("synchronize-main"),
  entries: z
    .array(z.object({ sourceID: z.string(), accountUUID: z.string().uuid() }))
    .min(1),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export type ClaudeActivationInput = {
  readonly expectedDirectories?: {
    readonly original: { readonly device: number; readonly inode: number };
    readonly candidate: { readonly device: number; readonly inode: number };
  };
  readonly stagingDirectory: string;
  readonly targetAuthDirectory: string;
  readonly poolFile: string;
  readonly nativeAuthFile: string;
  readonly assertQuiescent: () => Promise<void>;
};

export async function durableTransferRecord(path: string, record: unknown) {
  return durableTransferText(path, JSON.stringify(record));
}

export async function durableTransferText(path: string, text: string) {
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function activateClaudeTransfer(input: ClaudeActivationInput) {
  if (
    ![
      input.stagingDirectory,
      input.targetAuthDirectory,
      input.poolFile,
      input.nativeAuthFile,
    ].every(isAbsolute)
  )
    throw new ClaudeTransferError("INVALID_INPUT");
  await input.assertQuiescent();
  const lock = `${input.stagingDirectory}.lock`;
  await mkdir(lock, { mode: 0o700 });
  let archived = false;
  let installed = false;
  const archive = join(input.stagingDirectory, "auth-directory.before");
  const journal = join(input.stagingDirectory, "activation-intent.json");
  const assertDirectoryOwner = async (
    path: string,
    kind: "original" | "candidate",
  ) => {
    const expected = input.expectedDirectories?.[kind];
    if (!expected) return;
    const current = await lstat(path);
    if (
      !current.isDirectory() ||
      current.dev !== expected.device ||
      current.ino !== expected.inode
    )
      throw new ClaudeTransferError("SOURCE_CHANGED");
  };
  try {
    const ledger = ledgerSchema.parse(
      JSON.parse(
        await readPrivateTransferFile(
          join(input.stagingDirectory, "ledger.json"),
        ),
      ),
    );
    const source = await readPrivateTransferFile(input.poolFile);
    const auth = await readPrivateTransferFile(input.nativeAuthFile);
    if (ledger.nativeAuthMode === "synchronize-main")
      assertLegacyAuthMatchesPool(source, auth);
    if (
      hash(source) !== ledger.sourceSha256 ||
      hash(auth) !== ledger.nativeAuthSha256
    )
      throw new ClaudeTransferError("SOURCE_CHANGED");
    const plan = planClaudeTransfer(
      source,
      Object.fromEntries(
        ledger.entries.map((entry) => [entry.sourceID, entry.accountUUID]),
      ),
    );
    const pending = join(input.stagingDirectory, "pending-auth");
    if (
      JSON.stringify((await readdir(pending)).sort()) !==
      JSON.stringify(plan.files.map((file) => file.name).sort())
    )
      throw new ClaudeTransferError("ACCOUNT_MISMATCH");
    for (const file of plan.files) {
      if (
        hash(await readPrivateTransferFile(join(pending, file.name))) !==
        hash(JSON.stringify(file.value))
      )
        throw new ClaudeTransferError("SOURCE_CHANGED");
      const handle = await open(
        join(pending, file.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const path of [
      input.stagingDirectory,
      pending,
      input.targetAuthDirectory,
    ]) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new ClaudeTransferError("INVALID_INPUT");
    }
    if (
      (await readdir(input.targetAuthDirectory)).some(
        (name) => name !== "kv.db",
      )
    )
      throw new ClaudeTransferError("ACCOUNT_MISMATCH");
    const assertSourceUnchanged = async () => {
      if (
        hash(await readPrivateTransferFile(input.poolFile)) !==
          ledger.sourceSha256 ||
        hash(await readPrivateTransferFile(input.nativeAuthFile)) !==
          ledger.nativeAuthSha256
      )
        throw new ClaudeTransferError("SOURCE_CHANGED");
    };
    await input.assertQuiescent();
    await assertSourceUnchanged();
    await durableTransferRecord(journal, {
      phase: "activation-intent",
      sourceSha256: ledger.sourceSha256,
      at: Date.now(),
    });
    await assertDirectoryOwner(input.targetAuthDirectory, "original");
    await assertDirectoryOwner(pending, "candidate");
    await rename(input.targetAuthDirectory, archive);
    archived = true;
    await durableTransferRecord(
      join(input.stagingDirectory, "activation-archived.json"),
      {
        phase: "archived",
        at: Date.now(),
      },
    );
    await input.assertQuiescent();
    await assertSourceUnchanged();
    await assertDirectoryOwner(archive, "original");
    await assertDirectoryOwner(pending, "candidate");
    try {
      await lstat(input.targetAuthDirectory);
      throw new ClaudeTransferError("SOURCE_CHANGED");
    } catch (stateError) {
      if (!(
        stateError instanceof Error &&
        "code" in stateError &&
        stateError.code === "ENOENT"
      ))
        throw stateError;
    }
    await rename(pending, input.targetAuthDirectory);
    installed = true;
    await durableTransferRecord(
      join(input.stagingDirectory, "activation-installed.json"),
      {
        phase: "files-installed-services-stopped",
        at: Date.now(),
      },
    );
    return {
      phase: "files-installed-services-stopped",
      imported: plan.files.length,
    };
  } catch (error) {
    if (archived && !installed) {
      await assertDirectoryOwner(archive, "original");
      try {
        await lstat(input.targetAuthDirectory);
        throw new ClaudeTransferError("SOURCE_CHANGED");
      } catch (stateError) {
        if (!(
          stateError instanceof Error &&
          "code" in stateError &&
          stateError.code === "ENOENT"
        ))
          throw stateError;
      }
      await rename(archive, input.targetAuthDirectory);
      await durableTransferRecord(
        join(input.stagingDirectory, "activation-restored.json"),
        {
          phase: "previous-directory-restored",
          at: Date.now(),
        },
      );
    }
    throw error instanceof ClaudeTransferError
      ? error
      : new ClaudeTransferError("INVALID_INPUT");
  } finally {
    await rmdir(lock);
  }
}
