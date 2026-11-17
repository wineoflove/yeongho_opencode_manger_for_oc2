import type {
  StoredUsageEvent,
  UsageEventProvider,
} from "../../db/cliproxy-usage-events";

/** How long before a message is created its CLIProxy request may start. */
export const ATTRIBUTION_LEAD_MS = 2_000;
const REQUEST_TRAIL_MS = 1_000;
const MIN_SCORE_WITHOUT_SESSION = 2;
const PROXY_PROVIDERS: Readonly<Record<string, UsageEventProvider>> = {
  anthropic: "claude",
  openai: "codex",
};

/** The timing, model and token facts of one OpenCode assistant message used for matching. */
export interface AttributableMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

function firstAtOrAfter(
  events: readonly StoredUsageEvent[],
  time: number,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle]?.occurredAt ?? Infinity) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fingerprint(
  message: AttributableMessage,
  event: StoredUsageEvent,
): number {
  const { tokens } = event;
  return (
    (message.output === tokens.output - tokens.reasoning ? 2 : 0) +
    (message.cacheRead === tokens.cacheRead ? 1 : 0) +
    (message.input === tokens.uncached ? 1 : 0)
  );
}

function eventsByProvider(
  events: readonly StoredUsageEvent[],
): Map<UsageEventProvider, StoredUsageEvent[]> {
  const grouped = new Map<UsageEventProvider, StoredUsageEvent[]>();
  for (const event of events) {
    if (event.failed) continue;
    const list = grouped.get(event.provider);
    if (list) list.push(event);
    else grouped.set(event.provider, [event]);
  }
  for (const list of grouped.values())
    list.sort((a, b) => a.occurredAt - b.occurredAt || a.rowId - b.rowId);
  return grouped;
}

/**
 * Assigns each message at most one successful CLIProxy event and returns the serving account per message id.
 * Messages are matched in creation order and each event is used once; ties stay unattributed.
 */
export function attributeUsage(
  messages: readonly AttributableMessage[],
  events: readonly StoredUsageEvent[],
): Map<string, string> {
  const grouped = eventsByProvider(events);
  const consumed = new Set<StoredUsageEvent>();
  const accounts = new Map<string, string>();
  const ordered = [...messages].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  for (const message of ordered) {
    const provider = PROXY_PROVIDERS[message.provider];
    const list = provider ? grouped.get(provider) : undefined;
    if (!list) continue;
    const end = (message.completedAt ?? message.createdAt) + REQUEST_TRAIL_MS;
    let candidates: StoredUsageEvent[] = [];
    for (
      let index = firstAtOrAfter(list, message.createdAt - ATTRIBUTION_LEAD_MS);
      index < list.length;
      index += 1
    ) {
      const event = list[index];
      if (!event || event.occurredAt > end) break;
      if (!consumed.has(event) && event.models.includes(message.model))
        candidates.push(event);
    }
    const sameSession = candidates.filter(
      (event) =>
        event.sessionId !== null &&
        (event.sessionId === message.sessionId ||
          event.sessionId === message.rootSessionId),
    );
    if (sameSession.length > 0) candidates = sameSession;
    const threshold = sameSession.length > 0 ? 0 : MIN_SCORE_WITHOUT_SESSION;
    let best: StoredUsageEvent | undefined;
    let bestScore = -1;
    let tied = false;
    for (const event of candidates) {
      const score = fingerprint(message, event);
      if (score > bestScore) {
        best = event;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) tied = true;
    }
    if (!best || tied || bestScore < threshold) continue;
    consumed.add(best);
    accounts.set(message.id, best.authIndex);
  }
  return accounts;
}
