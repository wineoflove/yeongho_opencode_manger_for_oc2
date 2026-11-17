import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "../../shared/src/zod.ts";
import { openCodeErrorStatus } from "../../shared/src/opencode/index.ts";
import { openCodeApi } from "./opencode.mjs";
import {
  activeSessions,
  hasActivityAfter,
  hasPendingWork,
  readSession,
} from "./session-guard.mjs";
import { DELIVERY_MODES } from "./report-delivery.mjs";

async function reportDelivered(config, api, saved) {
  if (config.delivery === "file") {
    try {
      return (
        (await readFile(
          join(config.store, "reviews", "delivered", `${saved.message_id}.md`),
          "utf8",
        )) === saved.report
      );
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    const message = await api.session.message.get({
      sessionID: config.feedbackSession,
      messageID: saved.message_id,
    });
    return (
      (message.type === "user" ||
        (message.type === "synthetic" &&
          message.metadata?.source === "manager-report")) &&
      message.text === saved.report
    );
  } catch (error) {
    if (openCodeErrorStatus(error) === 404) return false;
    throw error;
  }
}

export function completionReceipt(run, feedbackSession, now = Date.now()) {
  if (
    run.status !== "completed" ||
    !run.finished_at ||
    now - run.finished_at < 60000
  )
    return null;
  if (!run.session_id || run.session_id === feedbackSession) return null;
  const output = run.response_text || "";
  for (const text of [
    ...(output.match(/\{[^\n]*\}/g) || []),
    ...(output.match(/\{[^{}]+\}/g) || []),
  ]) {
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      continue;
    }
    if (
      !["done", "already-reviewed"].includes(result.status) ||
      !["daily", "weekly"].includes(result.mode)
    )
      continue;
    if (!/^[a-f0-9]{24}$/.test(result.batch || "")) continue;
    if (result.feedbackSession && result.feedbackSession !== feedbackSession)
      continue;
    return { batch: result.batch, mode: result.mode };
  }
  return null;
}

/** Removes finished learning-review run sessions whose report delivery is verified and which have no later or pending work. */
export async function cleanup(config, client) {
  const manager = new Database(config.managerDb, { readonly: true });
  const ledger = new Database(join(config.store, "state", "reviews.sqlite"));
  ledger.exec(
    "CREATE TABLE IF NOT EXISTS cleaned_sessions(run_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, cleaned_at INTEGER NOT NULL)",
  );
  const removed = [];
  try {
    const jobs = config.cleanupJobIds;
    const rows = manager
      .query(
        `SELECT r.id,r.job_id,r.status,r.finished_at,r.session_id,r.response_text,j.name
      FROM schedule_runs r JOIN schedule_jobs j ON j.id=r.job_id
      WHERE r.job_id IN (?,?) AND r.status='completed' AND r.finished_at>=? ORDER BY r.id DESC LIMIT 200`,
      )
      .all(...jobs, config.cleanupEnabledAt ?? 0);
    const candidates = rows
      .filter(
        (run) =>
          !ledger
            .query("SELECT run_id FROM cleaned_sessions WHERE run_id=?")
            .get(run.id),
      )
      .map((run) => ({
        run,
        receipt: completionReceipt(run, config.feedbackSession),
      }))
      .filter(
        (item) =>
          item.receipt &&
          ((item.run.job_id === jobs[0] && item.receipt.mode === "daily") ||
            (item.run.job_id === jobs[1] && item.receipt.mode === "weekly")),
      );
    if (!candidates.length) return { removed };
    const api = client ?? openCodeApi();
    for (const { run, receipt } of candidates) {
      const saved = ledger
        .query(
          "SELECT message_id,report FROM runs WHERE id=? AND mode=? AND status='done'",
        )
        .get(receipt.batch, receipt.mode);
      if (!saved || !(await reportDelivered(config, api, saved))) continue;
      if ((await activeSessions(api))[run.session_id]) continue;
      const session = await readSession(api, run.session_id);
      if (!session) {
        ledger
          .query("INSERT OR IGNORE INTO cleaned_sessions VALUES(?,?,?)")
          .run(run.id, run.session_id, Date.now());
        continue;
      }
      if (
        session.id !== run.session_id ||
        session.location.directory !== config.directory ||
        session.parentID ||
        session.time.updated > run.finished_at
      )
        continue;
      if (await hasActivityAfter(api, run.session_id, run.finished_at))
        continue;
      if (await hasPendingWork(api, run.session_id)) continue;
      if ((await activeSessions(api))[run.session_id]) continue;
      await api.session.remove({ sessionID: run.session_id });
      ledger
        .query("INSERT OR IGNORE INTO cleaned_sessions VALUES(?,?,?)")
        .run(run.id, run.session_id, Date.now());
      removed.push(run.session_id);
    }
    return { removed };
  } finally {
    manager.close();
    ledger.close();
  }
}

if (import.meta.main) {
  const config = z
    .object({
      managerDb: z.string(),
      store: z.string(),
      directory: z.string(),
      delivery: z.enum(DELIVERY_MODES),
      feedbackSession: z.string().regex(/^ses_/),
      cleanupJobIds: z.tuple([
        z.number().int().positive(),
        z.number().int().positive(),
      ]),
      cleanupEnabledAt: z.number().int().nonnegative().default(0),
    })
    .parse(
      JSON.parse(
        await readFile(
          process.env.LEARNING_REVIEW_CONFIG ||
            join(
              process.env.WORKSPACE_PATH ||
                new URL("../../workspace", import.meta.url).pathname,
              ".opencode/learnings/review-config.json",
            ),
          "utf8",
        ),
      ),
    );
  try {
    process.stdout.write(`${JSON.stringify(await cleanup(config))}\n`);
  } catch (error) {
    process.stderr.write(
      `Learning review session cleanup failed: ${String(error).slice(0, 400)}\n`,
    );
    process.exitCode = 1;
  }
}
