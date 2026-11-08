import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { redact } from "./redact.mjs";
import { collectWeekly } from "./weekly.mjs";

export { redact };

/** SHA-256 of a JSON-serialised value, used for batch and lesson identities. */
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
};

const errorText = (value) =>
  typeof value === "string"
    ? value
    : typeof value?.message === "string"
      ? value.message
      : "";

const contentText = (content) =>
  Array.isArray(content)
    ? content
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("")
    : "";

/** Bounded, redacted evidence from one OpenCode 2 user or assistant message. */
function evidenceFor(type, data, parts) {
  if (type === "user")
    return typeof data.text === "string"
      ? [{ text: redact(data.text).slice(0, 700) }]
      : [];
  const content = parts.length
    ? parts
    : Array.isArray(data.content)
      ? data.content
      : [];
  return content
    .slice(0, 12)
    .flatMap((item) => {
      if (item?.type === "text")
        return [{ text: redact(item.text ?? "").slice(0, 700) }];
      if (item?.type === "tool")
        return [
          {
            tool: item.name,
            status: item.state?.status,
            error: redact(errorText(item.state?.error)).slice(0, 250),
            output: redact(contentText(item.state?.content)).slice(-400),
          },
        ];
      return [];
    })
    .slice(0, 4);
}

/**
 * Collects the next daily batch of completed OpenCode 2 messages from registered project directories,
 * excluding the feedback session and learning-review sessions with their descendants.
 */
export async function collect(config, mode, cursor, until) {
  if (mode === "weekly") return collectWeekly(config, until);
  const db = new Database(config.opencodeDb, { readonly: true });
  const manager = new Database(config.managerDb, { readonly: true });
  try {
    const directories = new Set([
      config.directory,
      ...manager
        .query("SELECT source_path,local_path FROM repos")
        .all()
        .map((r) => r.source_path || resolve(config.reposRoot, r.local_path)),
    ]);
    const sessions = new Map(
      db
        .query(
          "SELECT id,parent_id,coalesce(title,'') AS title,directory FROM session_v2",
        )
        .all()
        .map((s) => [s.id, s]),
    );
    const reviewRoots = new Set(
      manager
        .query(
          `SELECT r.session_id FROM schedule_runs r JOIN schedule_jobs j ON j.id=r.job_id
      WHERE j.name IN ('학습 일일 리뷰','학습 주간 리뷰')`,
        )
        .all()
        .map((r) => r.session_id),
    );
    const excluded = (id) => {
      const visited = new Set();
      while (id && !visited.has(id)) {
        visited.add(id);
        const s = sessions.get(id);
        if (!s) return false;
        if (
          id === config.feedbackSession ||
          reviewRoots.has(id) ||
          /^\[Learning review\]|^학습 (일일|주간) 리뷰/.test(s.title)
        )
          return true;
        id = s.parent_id;
      }
      return false;
    };
    const rows = db
      .query(
        `SELECT id,session_id,type,time_updated,data FROM session_message
      WHERE (time_updated>? OR (time_updated=? AND id>?)) AND time_updated<=?
      AND (type='user' OR (type='assistant' AND json_extract(data,'$.time.completed') IS NOT NULL))
      ORDER BY time_updated,id LIMIT 300`,
      )
      .all(cursor.time, cursor.time, cursor.id, until);
    const partsOf = db.query(
      "SELECT data FROM session_part WHERE message_id=? ORDER BY ordinal LIMIT 12",
    );
    const records = [];
    let last = cursor;
    let scanned = 0;
    for (const row of rows) {
      last = { time: row.time_updated, id: row.id };
      scanned++;
      const session = sessions.get(row.session_id);
      if (!directories.has(session?.directory) || excluded(row.session_id))
        continue;
      const data = parse(row.data);
      const parts =
        row.type === "assistant"
          ? partsOf.all(row.id).map((p) => parse(p.data))
          : [];
      records.push({
        id: row.id,
        session: row.session_id,
        project: session.directory.split("/").at(-1),
        role: row.type,
        error: redact(errorText(data.error)).slice(0, 300),
        evidence: evidenceFor(row.type, data, parts),
      });
      if (records.length >= 30) break;
    }
    return {
      records,
      cursor: last,
      more: scanned < rows.length || rows.length === 300,
      from: cursor.time,
      through: last.time,
    };
  } finally {
    db.close();
    manager.close();
  }
}
