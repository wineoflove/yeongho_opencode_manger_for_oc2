import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "../../shared/src/zod.ts";
import { DELIVERY_MODES } from "../learning-review/report-delivery.mjs";
import { lifecycle } from "./lifecycle.mjs";

const absolute = z.string().refine(isAbsolute, "Expected an absolute path");

/** Workspace-backup lifecycle settings, read from `${WORKSPACE_PATH}/.opencode/workspace-backup/config.json`. */
export const configPath = join(
  process.env.WORKSPACE_PATH ||
    fileURLToPath(new URL("../../workspace", import.meta.url)),
  ".opencode/workspace-backup/config.json",
);
export const Config = z.object({
  managerDb: absolute,
  ledger: absolute,
  store: absolute,
  directory: absolute,
  feedbackSession: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  delivery: z.enum(DELIVERY_MODES),
  jobId: z.number().int().positive(),
  enabledAt: z.number().int().positive(),
  graceMs: z.number().int().min(300000),
});

if (import.meta.main) {
  process.umask(0o077);
  try {
    const config = Config.parse(JSON.parse(await readFile(configPath, "utf8")));
    const result = await lifecycle(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.errors.length) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Workspace backup lifecycle failed; sessions retained.\n",
    );
    process.exitCode = 1;
  }
}
