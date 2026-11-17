import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openCodeApi } from "../learning-review/opencode.mjs";
import {
  activeSessions,
  hasActivityAfter,
  hasPendingWork,
  readSession,
} from "../learning-review/session-guard.mjs";
import { redact } from "../learning-review/data.mjs";
import { publishExactReport } from "../learning-review/report-delivery.mjs";

export const successMarker = "WORKSPACE_BACKUP_RESULT_V1=verified";

export function formatReport(run) {
  return `## 워크스페이스 설정 백업 / 실행 ${run.id}\n\n완료 시각: ${new Date(run.finished_at).toISOString()}\n상태: ${run.status}\n원본 세션: ${run.session_id}\n\n${redact(run.response_text || "(최종 응답이 없어 진단을 위해 보존합니다.)")}\n${redact(run.error_text || "")}`;
}

export function reportMatchesSource(run, report) {
  const legacy = `## Workspace config backup / run ${run.id}\n\nFinished: ${new Date(run.finished_at).toISOString()}\nStatus: ${run.status}\nSource session: ${run.session_id}\n\n${redact(run.response_text || "(No final response; retained for diagnosis.)")}\n${redact(run.error_text || "")}`;
  return report === formatReport(run) || report === legacy;
}

export function eligible(run, config, now) {
  return (
    run.job_id === config.jobId &&
    run.repo_id === 0 &&
    run.started_at >= config.enabledAt &&
    ["completed", "failed", "cancelled"].includes(run.status) &&
    Number.isFinite(run.finished_at) &&
    run.finished_at >= run.started_at &&
    now - run.finished_at >= config.graceMs &&
    !!run.session_id &&
    run.session_id !== config.feedbackSession
  );
}

/** Publishes a backup report exactly once through the configured learning-review delivery channel. */
export async function publishVerified(config, messageID, report, api) {
  return publishExactReport(
    config,
    messageID,
    report,
    ["prompt", "noReply"].includes(config.delivery)
      ? (api ?? openCodeApi())
      : api,
  );
}

/** True when an OpenCode 2 backup session is idle, unchanged since the run finished, and has no children or pending requests. */
export async function safeSession(config, run, api) {
  if ((await activeSessions(api))[run.session_id]) return false;
  const session = await readSession(api, run.session_id);
  if (
    !session ||
    session.id !== run.session_id ||
    session.location.directory !== config.directory ||
    session.parentID ||
    session.title !== run.session_title ||
    session.time.created < run.started_at ||
    session.time.updated > run.finished_at
  )
    return false;
  if (await hasActivityAfter(api, run.session_id, run.finished_at))
    return false;
  return !(await hasPendingWork(api, run.session_id));
}

export async function lifecycle(config, client, now = Date.now()) {
  let api = client;
  const manager = new Database(config.managerDb, { readonly: true });
  const ledger = new Database(config.ledger);
  ledger.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reports(run_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
      message_id TEXT NOT NULL, report TEXT NOT NULL, delivered_at INTEGER, deleted_at INTEGER);`);
  const result = { published: [], removed: [], retained: [], errors: [] };
  try {
    const runs = manager
      .query(
        `SELECT r.* FROM schedule_runs r JOIN schedule_jobs j ON j.id=r.job_id
      WHERE r.job_id=? AND r.repo_id=0 AND j.repo_id=0 AND j.name='workspace-config-backup'
      AND r.started_at>=? AND r.status IN ('completed','failed','cancelled') ORDER BY r.id`,
      )
      .all(config.jobId, config.enabledAt);
    for (const run of runs) {
      if (!eligible(run, config, now)) continue;
      let saved = ledger
        .query("SELECT * FROM reports WHERE run_id=?")
        .get(run.id);
      if (saved?.deleted_at) continue;
      try {
        if (!saved) {
          const hash = createHash("sha256")
            .update(`workspace-backup-v1:${run.id}:${run.session_id}`)
            .digest("hex");
          const messageID = `msg_${((BigInt(run.started_at) << 12n) + 1n).toString(16).slice(-12)}${hash.slice(0, 14)}`;
          const report = formatReport(run);
          ledger
            .query(
              "INSERT INTO reports(run_id,session_id,message_id,report) VALUES(?,?,?,?)",
            )
            .run(run.id, run.session_id, messageID, report);
          saved = ledger
            .query("SELECT * FROM reports WHERE run_id=?")
            .get(run.id);
        }
        if (
          saved.session_id !== run.session_id ||
          !reportMatchesSource(run, saved.report)
        )
          throw new Error("Backup source changed");
        api ??= openCodeApi();
        await publishVerified(config, saved.message_id, saved.report, api);
        ledger
          .query("UPDATE reports SET delivered_at=? WHERE run_id=?")
          .run(now, run.id);
        result.published.push(run.id);
        if (
          run.status !== "completed" ||
          run.error_text ||
          !run.response_text?.trim().endsWith(successMarker)
        ) {
          result.retained.push(run.id);
          continue;
        }
        if (!(await safeSession(config, run, api))) {
          result.retained.push(run.id);
          continue;
        }
        const latest = manager
          .query("SELECT * FROM schedule_runs WHERE id=?")
          .get(run.id);
        if (
          latest.status !== run.status ||
          latest.session_id !== run.session_id ||
          latest.finished_at !== run.finished_at ||
          latest.response_text !== run.response_text ||
          latest.error_text !== run.error_text
        )
          continue;
        await publishVerified(config, saved.message_id, saved.report, api);
        if (!(await safeSession(config, run, api))) continue;
        await api.session.remove({ sessionID: run.session_id });
        ledger
          .query("UPDATE reports SET deleted_at=? WHERE run_id=?")
          .run(Date.now(), run.id);
        result.removed.push(run.session_id);
      } catch {
        result.errors.push(run.id);
      }
    }
    return result;
  } finally {
    manager.close();
    ledger.close();
  }
}
