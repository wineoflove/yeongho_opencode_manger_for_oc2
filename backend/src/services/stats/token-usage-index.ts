import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { TokenFilterDimension } from "@opencode-manager/shared/schemas";
import { getRepoDisplayName } from "@opencode-manager/shared/utils";
import {
  recordTotal,
  type DimensionLabel,
  type UsageIndexSnapshot,
  type UsageRecord,
} from "./aggregate";

export const MAIN_CATEGORY = "main";
export const UNKNOWN = "unknown";
export const UNATTRIBUTED = "unattributed";

export interface StatsRepo {
  readonly fullPath: string;
  readonly name?: string;
  readonly repoUrl?: string;
  readonly localPath?: string;
  readonly sourcePath?: string;
}

export interface TokenUsageIndexOptions {
  readonly openCodeDbPath: string;
  readonly listRepos: () => readonly StatsRepo[];
  readonly refreshIntervalMs?: number;
  readonly now?: () => number;
}

interface UsageMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly provider: string;
  readonly model: string;
  readonly agent: string;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

interface UsageSession {
  readonly id: string;
  readonly parentId: string | null;
  readonly directory: string;
  readonly worktree: string | null;
  readonly title: string;
  readonly agent: string | null;
}

interface MessageRow {
  readonly rowid: number;
  readonly id: string;
  readonly session_id: string;
  readonly time_created: number;
  readonly time_updated: number;
  readonly data: string;
}

interface SessionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly directory: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly worktree: string | null;
}

const PAGE_SIZE = 2000;
const DEFAULT_REFRESH_MS = 15_000;
const UPDATE_OVERLAP_MS = 2_000;
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};
const MESSAGE_COLUMNS =
  "rowid, id, session_id, time_created, time_updated, data";

const yieldToEventLoop = () =>
  new Promise<void>((resolveYield) => setImmediate(resolveYield));

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseAssistantMessage(
  row: Pick<MessageRow, "id" | "session_id" | "time_created" | "data">,
): UsageMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const data = object(parsed);
  const tokens = object(data.tokens);
  const cache = object(tokens.cache);
  const model = object(data.model);
  const message: UsageMessage = {
    id: row.id,
    sessionId: row.session_id,
    createdAt: num(object(data.time).created) || row.time_created,
    provider: str(model.providerID, UNKNOWN),
    model: str(model.id, UNKNOWN),
    agent: str(data.agent, UNKNOWN),
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
    cost: num(data.cost),
  };
  return message.input +
    message.output +
    message.reasoning +
    message.cacheRead +
    message.cacheWrite >
    0
    ? message
    : null;
}

export function categoryFromTitle(title: string): string | undefined {
  const agent = /\(@([^)\s]+) subagent\)\s*$/.exec(title)?.[1];
  return agent ? `@${agent}` : undefined;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!!path && !path.startsWith("..") && !isAbsolute(path));
}

export class TokenUsageIndex {
  private db: Database | null = null;
  private readonly messages = new Map<string, UsageMessage>();
  private lastRowId = 0;
  private watermark = 0;
  private sessions = new Map<string, UsageSession>();
  private snapshot: UsageIndexSnapshot | null = null;
  private refreshedAt = -Infinity;
  private inflight: Promise<UsageIndexSnapshot> | null = null;

  constructor(private readonly options: TokenUsageIndexOptions) {}

  async getSnapshot(): Promise<UsageIndexSnapshot> {
    if (
      this.snapshot &&
      this.now() - this.refreshedAt <
        (this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS)
    )
      return this.snapshot;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private database(): Database | null {
    if (this.db) return this.db;
    if (!existsSync(this.options.openCodeDbPath)) return null;
    this.db = new Database(this.options.openCodeDbPath, { readonly: true });
    return this.db;
  }

  private async refresh(): Promise<UsageIndexSnapshot> {
    const db = this.database();
    if (db) {
      this.loadSessions(db);
      await this.loadMessages(db);
    }
    this.snapshot = this.buildSnapshot();
    this.refreshedAt = this.now();
    return this.snapshot;
  }

  private loadSessions(db: Database): void {
    const rows = db
      .query(
        `SELECT s.id, s.parent_id, s.directory, s.title, s.agent, p.worktree
        FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id`,
      )
      .all() as SessionRow[];
    this.sessions = new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          parentId: row.parent_id,
          directory: row.directory,
          worktree: row.worktree,
          title: row.title ?? "",
          agent: row.agent,
        },
      ]),
    );
    for (const [id, message] of this.messages) {
      if (!this.sessions.has(message.sessionId)) this.messages.delete(id);
    }
  }

  private upsertMessage(row: MessageRow): void {
    const message = this.sessions.has(row.session_id)
      ? parseAssistantMessage(row)
      : null;
    if (message) this.messages.set(row.id, message);
    else this.messages.delete(row.id);
    this.watermark = Math.max(this.watermark, row.time_updated);
  }

  private async loadMessages(db: Database): Promise<void> {
    const page = db.query(
      `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE type = 'assistant' AND rowid > ? ORDER BY rowid LIMIT ?`,
    );
    const since = this.watermark - UPDATE_OVERLAP_MS;
    while (true) {
      const rows = page.all(this.lastRowId, PAGE_SIZE) as MessageRow[];
      for (const row of rows) {
        this.upsertMessage(row);
        this.lastRowId = Math.max(this.lastRowId, row.rowid);
      }
      if (rows.length < PAGE_SIZE) break;
      await yieldToEventLoop();
    }
    if (since > 0) {
      const updated = db
        .query(
          `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE type = 'assistant' AND time_updated > ?`,
        )
        .all(since) as MessageRow[];
      for (const row of updated) this.upsertMessage(row);
    }
  }

  private rootOf(sessionId: string): UsageSession | undefined {
    let session = this.sessions.get(sessionId);
    const seen = new Set<string>();
    while (session?.parentId && !seen.has(session.id)) {
      seen.add(session.id);
      const parent = this.sessions.get(session.parentId);
      if (!parent) break;
      session = parent;
    }
    return session;
  }

  private categoryOf(session: UsageSession | undefined): string {
    if (!session?.parentId) return MAIN_CATEGORY;
    if (session.agent) return `@${session.agent}`;
    return categoryFromTitle(session.title) ?? UNKNOWN;
  }

  private buildSnapshot(): UsageIndexSnapshot {
    const repos = [...this.options.listRepos()].sort(
      (a, b) => b.fullPath.length - a.fullPath.length,
    );
    const labels = new Map<TokenFilterDimension, Map<string, DimensionLabel>>();
    const setLabel = (
      dimension: TokenFilterDimension,
      key: string,
      label: DimensionLabel,
    ) => {
      const map = labels.get(dimension) ?? new Map<string, DimensionLabel>();
      if (!map.has(key)) map.set(key, label);
      labels.set(dimension, map);
    };
    const providerLabel = (provider: string) =>
      PROVIDER_LABELS[provider] ?? provider;
    const projectCache = new Map<
      string,
      { key: string; label: DimensionLabel }
    >();
    const projectOf = (session: UsageSession | undefined) => {
      const path =
        session?.worktree && session.worktree !== "/"
          ? session.worktree
          : (session?.directory ?? UNKNOWN);
      const cached = projectCache.get(path);
      if (cached) return cached;
      const repo =
        path === UNKNOWN
          ? undefined
          : repos.find((candidate) => isInside(candidate.fullPath, path));
      const project = repo
        ? {
            key: repo.fullPath,
            label: { label: getRepoDisplayName(repo), detail: repo.fullPath },
          }
        : {
            key: path,
            label: {
              label: path === UNKNOWN ? "Unknown" : basename(path) || path,
              detail: path,
            },
          };
      projectCache.set(path, project);
      return project;
    };

    const records: UsageRecord[] = [];
    let firstMessageAt: number | null = null;
    for (const message of this.messages.values()) {
      const session = this.sessions.get(message.sessionId);
      const root = this.rootOf(message.sessionId) ?? session;
      const project = projectOf(root);
      const category = this.categoryOf(session);
      const account = `${message.provider}:${UNATTRIBUTED}`;
      const keys = {
        model: `${message.provider}/${message.model}`,
        provider: message.provider,
        account,
        project: project.key,
        agent: message.agent,
        category,
        session: root?.id ?? message.sessionId,
      };
      setLabel("model", keys.model, {
        label: message.model,
        detail: providerLabel(message.provider),
      });
      setLabel("provider", keys.provider, {
        label: providerLabel(message.provider),
      });
      setLabel("project", keys.project, project.label);
      setLabel("agent", keys.agent, { label: message.agent });
      setLabel("session", keys.session, {
        label: root?.title || keys.session,
        detail: project.label.label,
      });
      setLabel(
        "category",
        category,
        category === MAIN_CATEGORY
          ? { label: "Main session", detail: "Not delegated" }
          : category.startsWith("@")
            ? { label: category, detail: "Direct agent" }
            : { label: "Unknown", detail: "Category" },
      );
      setLabel("account", account, {
        label: `${providerLabel(message.provider)} · unattributed`,
        detail: "Per-request account attribution is not recorded",
      });
      const record: UsageRecord = {
        messageId: message.id,
        rootSessionId: keys.session,
        createdAt: message.createdAt,
        keys,
        input: message.input,
        output: message.output,
        reasoning: message.reasoning,
        cacheRead: message.cacheRead,
        cacheWrite: message.cacheWrite,
        cost: message.cost,
      };
      if (recordTotal(record) === 0) continue;
      records.push(record);
      firstMessageAt =
        firstMessageAt === null
          ? message.createdAt
          : Math.min(firstMessageAt, message.createdAt);
    }
    records.sort((a, b) => a.createdAt - b.createdAt);
    return {
      records,
      label: (dimension, key) =>
        labels.get(dimension)?.get(key) ?? { label: key },
      isAttributedAccount: () => false,
      trackedSince: null,
      firstMessageAt,
    };
  }
}
