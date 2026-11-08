import { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { inside } from "./application-files.mjs";
import { openCodeApi } from "./opencode.mjs";

const EDIT_TOOLS = new Set(["edit", "write", "patch"]);
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 30 * 60 * 1000;
const PATCH_FILE =
  /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

function rootOf(sessions, id) {
  const chain = [];
  let current = id;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = sessions.get(current)?.parent_id ?? null;
  }
  return chain;
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const canonical = async (path) => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/** File paths an OpenCode 2 `edit`, `write` or `patch` call names, as written by the model. */
function editedPaths(item) {
  const input = item?.state?.input ?? {};
  if (typeof input.path === "string") return [input.path];
  if (typeof input.patchText !== "string") return [];
  return [...input.patchText.matchAll(PATCH_FILE)].map((match) =>
    (match[1] ?? match[2]).trim(),
  );
}

/**
 * Reports other OpenCode 2 sessions that edited `path` within the last day and are still running or edited it in the
 * last 30 minutes, so a learning application does not overwrite concurrent work. Paths are resolved against each
 * editing session's directory, and the caller's own session lineage is ignored.
 */
export async function editClaims(
  config,
  path,
  { self, now = Date.now(), api } = {},
) {
  if (!config.runtime?.sessionDb) throw new Error("RUNTIME_NOT_CONFIGURED");
  if (!self) throw new Error("SELF_SESSION_REQUIRED");
  if (!isAbsolute(path)) throw new Error("ABSOLUTE_TARGET_REQUIRED");
  const target = { path: await realpath(path) };
  const spellings = new Set([resolve(path), target.path]);
  const roots = await Promise.all(
    config.codeRoots.map((root) => realpath(root)),
  );
  if (
    !roots.some((root) => inside(root, target.path)) &&
    !config.policies.some((policy) => policy.path === path)
  )
    throw new Error("TARGET_NOT_ALLOWED");
  const db = new Database(config.runtime.sessionDb, { readonly: true });
  const sessions = new Map();
  const lastEdit = new Map();
  try {
    const lookup = db.query(
      "SELECT id, parent_id, coalesce(title, '') AS title, directory FROM session_v2 WHERE id = ?",
    );
    const visit = (id) => {
      while (id && !sessions.has(id)) {
        const row = lookup.get(id);
        if (!row) return;
        sessions.set(id, row);
        id = row.parent_id;
      }
    };
    const name = basename(target.path);
    const since = now - LOOKBACK_MS;
    const items = [
      ...db
        .query(
          `SELECT m.session_id AS sessionId, m.time_created AS time, j.value AS item FROM session_message m, json_each(json_extract(m.data, '$.content')) j
          WHERE m.type = 'assistant' AND m.time_created > ? AND json_extract(j.value, '$.type') = 'tool' AND instr(j.value, ?) > 0
          AND NOT EXISTS (SELECT 1 FROM session_part p WHERE p.message_id = m.id)`,
        )
        .all(since, name),
      ...db
        .query(
          `SELECT session_id AS sessionId, time_created AS time, data AS item FROM session_part
          WHERE type = 'tool' AND time_created > ? AND instr(data, ?) > 0`,
        )
        .all(since, name),
    ];
    for (const row of items) {
      const item = parse(row.item);
      if (!EDIT_TOOLS.has(item?.name)) continue;
      visit(row.sessionId);
      const directory = sessions.get(row.sessionId)?.directory;
      if (!directory) continue;
      const resolved = await Promise.all(
        editedPaths(item).map((edited) => canonical(resolve(directory, edited))),
      );
      if (!resolved.some((edited) => spellings.has(edited))) continue;
      lastEdit.set(
        row.sessionId,
        Math.max(lastEdit.get(row.sessionId) ?? 0, row.time),
      );
    }
    visit(self);
  } finally {
    db.close();
  }
  const conflicts = [];
  let active;
  for (const [sessionId, last] of lastEdit) {
    const chain = rootOf(sessions, sessionId);
    if (chain.includes(self) || rootOf(sessions, self).includes(sessionId))
      continue;
    const root = sessions.get(chain.at(-1));
    if (!root) throw new Error("SESSION_LINEAGE_UNKNOWN");
    active ??= await (api ?? openCodeApi()).session.active();
    const busy = chain.some((id) => Boolean(active[id]));
    const recent = now - last < RECENT_MS;
    if (busy || recent)
      conflicts.push({
        sessionId,
        rootSessionId: root.id,
        title: root.title,
        busy,
        lastEditAt: new Date(last).toISOString(),
      });
  }
  return {
    path: target.path,
    checkedAt: new Date(now).toISOString(),
    lookbackHours: LOOKBACK_MS / 3600000,
    editingSessions: lastEdit.size,
    conflicts,
    free: conflicts.length === 0,
  };
}
