import { openCodeErrorStatus } from "../../shared/src/opencode/index.ts";
import { z } from "../../shared/src/zod.ts";

const finite = z.number().finite();
const active = z.record(z.string(), z.object({}).passthrough());
const session = z
  .object({
    id: z.string(),
    parentID: z.string().optional(),
    title: z.string().optional(),
    location: z.object({ directory: z.string() }).passthrough(),
    time: z.object({ created: finite, updated: finite }).passthrough(),
  })
  .passthrough();
const messagePage = z.object({
  data: z.array(
    z
      .object({
        time: z
          .object({ created: finite, completed: finite.optional() })
          .passthrough(),
      })
      .passthrough(),
  ),
  cursor: z.object({ next: z.string().nullable().optional() }).passthrough(),
});
const sessionPage = z
  .object({ data: z.array(z.object({}).passthrough()) })
  .passthrough();
const list = z.array(z.object({}).passthrough());

/**
 * Validated OpenCode 2 reads used before deleting a session. Every reader throws on a response whose shape it cannot
 * trust, so callers that delete sessions treat malformed or partial data as unknown state and keep the session.
 */
export async function activeSessions(api) {
  return active.parse(await api.session.active());
}

/** The session, or null when OpenCode reports it no longer exists. */
export async function readSession(api, sessionID) {
  try {
    return session.parse(await api.session.get({ sessionID }));
  } catch (error) {
    if (openCodeErrorStatus(error) === 404) return null;
    throw error;
  }
}

/** True when any message was created or completed after `finishedAt`. */
export async function hasActivityAfter(api, sessionID, finishedAt) {
  const seen = new Set();
  let cursor;
  do {
    const page = messagePage.parse(
      await api.message.list({
        sessionID,
        limit: 100,
        ...(cursor ? { cursor } : { order: "asc" }),
      }),
    );
    if (
      page.data.some(
        (message) =>
          message.time.created > finishedAt ||
          (message.time.completed ?? 0) > finishedAt,
      )
    )
      return true;
    cursor = page.cursor.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("MESSAGE_CURSOR_REPEATED");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return false;
}

/** True when the session has child sessions, pending permission requests or open forms. */
export async function hasPendingWork(api, sessionID) {
  if (
    sessionPage.parse(await api.session.list({ parentID: sessionID, limit: 1 }))
      .data.length
  )
    return true;
  if (list.parse(await api.permission.list({ sessionID })).length) return true;
  return list.parse(await api.session.form.list({ sessionID })).length > 0;
}
