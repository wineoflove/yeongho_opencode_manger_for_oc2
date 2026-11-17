import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { durableTransferText } from "./claude-transfer-activate";

export class MaintenanceLaunchdError extends Error {
  constructor(
    readonly code:
      | "INVALID_SCOPE"
      | "STATE_UNKNOWN"
      | "IDENTITY_CHANGED"
      | "BOOTSTRAP_FAILED"
      | "HEALTH_TIMEOUT"
      | "CANCELLED"
      | "BOOTOUT_FAILED"
      | "PID_UNOBSERVED"
      | "STATE_PERSIST_FAILED",
  ) {
    super(code);
    this.name = "MaintenanceLaunchdError";
  }
}

const definitionSchema = z.object({
  Label: z.string(),
  ProgramArguments: z.array(z.string()).min(1),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function readLaunchdDefinition(source: string) {
  const file = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      before.size > 1024 * 1024
    )
      throw new MaintenanceLaunchdError("INVALID_SCOPE");
    const text = await file.readFile("utf8");
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new MaintenanceLaunchdError("IDENTITY_CHANGED");
    return text;
  } finally {
    await file.close();
  }
}

export async function snapshotLaunchdDefinition(
  source: string,
  label: string,
  stateDirectory: string,
) {
  if (!isAbsolute(source) || !isAbsolute(stateDirectory))
    throw new MaintenanceLaunchdError("INVALID_SCOPE");
  const directory = await lstat(stateDirectory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077 ||
    (await realpath(stateDirectory)) !== stateDirectory
  )
    throw new MaintenanceLaunchdError("INVALID_SCOPE");
  const text = await readLaunchdDefinition(source);
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    {
      input: text,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new MaintenanceLaunchdError("INVALID_SCOPE");
  const parsed = definitionSchema.safeParse(JSON.parse(result.stdout));
  if (
    !parsed.success ||
    parsed.data.Label !== label ||
    !isAbsolute(parsed.data.ProgramArguments[0] ?? "")
  )
    throw new MaintenanceLaunchdError("IDENTITY_CHANGED");
  const path = join(stateDirectory, `launchd-definition-${randomUUID()}.plist`);
  await durableTransferText(path, text);
  return { path, sha256: hash(text) };
}

export async function assertLaunchdDefinition(
  path: string | undefined,
  expected: string | undefined,
) {
  if (
    !path ||
    !expected ||
    hash(await readLaunchdDefinition(path)) !== expected
  )
    throw new MaintenanceLaunchdError("IDENTITY_CHANGED");
}

export async function boundedLaunchdHealth(
  check: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
) {
  const failure = () =>
    new MaintenanceLaunchdError(
      signal.reason instanceof DOMException &&
        signal.reason.name === "TimeoutError"
        ? "HEALTH_TIMEOUT"
        : "CANCELLED",
    );
  if (signal.aborted) throw failure();
  let rejectAborted: (reason: MaintenanceLaunchdError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => rejectAborted(failure());
  signal.addEventListener("abort", abort, { once: true });
  const probe = async () => {
    try {
      return await check(signal);
    } catch (error) {
      if (error instanceof MaintenanceLaunchdError) throw error;
      return false;
    }
  };
  try {
    const result = await Promise.race([probe(), aborted]);
    if (signal.aborted) throw failure();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
