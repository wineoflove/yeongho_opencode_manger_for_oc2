import type { Database } from "bun:sqlite";
import type {
  MessageSearchQuery,
  MessageSearchResponse,
} from "@opencode-manager/shared/schemas";

export type MessageSearchOptions = {
  readonly sourcePath: string;
  readonly indexPath: string;
  readonly projection: string;
};

type TextRow = {
  readonly part_id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly session_title: string;
  readonly directory: string;
  readonly time_archived: number | null;
  readonly role: "user" | "assistant";
  readonly created_at: number;
  readonly text: string;
};

export class MessageSearchEngine {
  private readonly source: Database;
  private readonly index: Database;
  private stopped = false;
  private refreshed = false;

  constructor(DatabaseClass: typeof Database, options: MessageSearchOptions) {
    this.source = new DatabaseClass(options.sourcePath, { readonly: true });
    try {
      this.source.exec(
        `CREATE TEMP VIEW searchable_text AS ${options.projection}`,
      );
      this.index = new DatabaseClass(options.indexPath);
      try {
        this.index.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES ('cursor',0),('watermark',0);
        CREATE TABLE IF NOT EXISTS content(part_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,created_at INTEGER NOT NULL,text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS content_message ON content(message_id);
        CREATE INDEX IF NOT EXISTS content_time ON content(created_at DESC,part_id DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text,content='content',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS content_insert AFTER INSERT ON content BEGIN
          INSERT INTO search(rowid,text) VALUES(new.rowid,new.text); END;
        CREATE TRIGGER IF NOT EXISTS content_delete AFTER DELETE ON content BEGIN
          INSERT INTO search(search,rowid,text) VALUES('delete',old.rowid,old.text); END;`);
      } catch (error) {
        this.index.close();
        throw error;
      }
    } catch (error) {
      this.source.close();
      throw error;
    }
  }

  private value(key: string): number {
    return (
      this.index
        .query<{ value: number }, [string]>(
          "SELECT value FROM meta WHERE key=?",
        )
        .get(key)?.value ?? 0
    );
  }

  status(): MessageSearchResponse["indexing"] {
    const indexedRowid = this.value("cursor");
    const maxRowid =
      this.source
        .query<{ maximum: number }, []>(
          "SELECT coalesce(max(rowid),0) maximum FROM session_message",
        )
        .get()?.maximum ?? 0;
    return {
      complete: this.refreshed && indexedRowid >= maxRowid,
      indexedRowid,
      maxRowid,
    };
  }

  async refresh(): Promise<void> {
    const started = Date.now();
    const since = this.refreshed
      ? Math.max(0, this.value("watermark") - 1000)
      : 0;
    const previous = this.refreshed ? this.value("cursor") : 0;
    const maximum = this.status().maxRowid;
    let cursor = 0;
    const page = this.source.query<
      { rowid: number; id: string },
      [number, number, number, number, number]
    >(`
      SELECT m.rowid,m.id FROM session_message m WHERE m.rowid>? AND m.rowid<=?
        AND (m.rowid>? OR m.time_updated>=? OR EXISTS(
          SELECT 1 FROM session_part p WHERE p.message_id=m.id AND p.time_updated>=?))
      ORDER BY m.rowid LIMIT 32`);
    const select = this.source.query<TextRow, [string]>(
      "SELECT * FROM searchable_text WHERE message_id=?",
    );
    const remove = this.index.query("DELETE FROM content WHERE message_id=?");
    const insert = this.index.query("INSERT INTO content VALUES (?,?,?,?,?)");
    while (!this.stopped) {
      const messages = page.all(cursor, maximum, previous, since, since);
      const last = messages.at(-1);
      if (!last) break;
      for (const message of messages) {
        const rows = select.all(message.id);
        this.index.transaction(() => {
          remove.run(message.id);
          for (const row of rows)
            insert.run(
              row.part_id,
              row.message_id,
              row.session_id,
              row.created_at,
              row.text,
            );
        })();
      }
      cursor = last.rowid;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (this.stopped) return;
    const existing = this.source.query<TextRow, [string, string]>(
      "SELECT * FROM searchable_text WHERE message_id=? AND part_id=?",
    );
    const indexedPage = this.index.query<
      { part_id: string; message_id: string },
      [string]
    >(
      "SELECT part_id,message_id FROM content WHERE part_id>? ORDER BY part_id LIMIT 256",
    );
    const discard = this.index.query("DELETE FROM content WHERE part_id=?");
    let lastPart = "";
    while (!this.stopped) {
      const rows = indexedPage.all(lastPart);
      const last = rows.at(-1);
      if (!last) break;
      const obsolete = rows.filter(
        (row) => !existing.get(row.message_id, row.part_id),
      );
      this.index.transaction(() => {
        for (const row of obsolete) discard.run(row.part_id);
      })();
      lastPart = last.part_id;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (this.stopped) return;
    this.index.transaction(() => {
      this.index
        .query("UPDATE meta SET value=? WHERE key='cursor'")
        .run(maximum);
      this.index
        .query("UPDATE meta SET value=? WHERE key='watermark'")
        .run(started);
    })();
    this.refreshed = true;
  }

  search(query: MessageSearchQuery): MessageSearchResponse {
    const terms = query.q.split(/\s+/u);
    const fts = terms.every((term) => Array.from(term).length >= 3);
    const predicate = fts
      ? "rowid IN (SELECT rowid FROM search WHERE search MATCH ?)"
      : terms.map(() => "instr(lower(text),lower(?))>0").join(" AND ");
    const parameters = fts
      ? [terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")]
      : terms;
    const candidates = this.index.prepare<
      { part_id: string; message_id: string },
      string[]
    >(
      `SELECT part_id,message_id FROM content WHERE ${predicate} ORDER BY created_at DESC,part_id DESC`,
    );
    const live = this.source.query<TextRow, [string, string]>(
      "SELECT * FROM searchable_text WHERE message_id=? AND part_id=?",
    );
    const hits: MessageSearchResponse["results"] = [];
    const counts = new Map<string, number>();
    let offset = 0;
    try {
      for (const candidate of candidates.iterate(...parameters)) {
        const row = live.get(candidate.message_id, candidate.part_id);
        if (
          !row ||
          (query.directory !== undefined &&
            row.directory !== query.directory) ||
          (query.directories !== undefined &&
            !query.directories.includes(row.directory))
        )
          continue;
        if (
          !terms.every((term) =>
            row.text.toLowerCase().includes(term.toLowerCase()),
          )
        )
          continue;
        const count = counts.get(row.session_id) ?? 0;
        if (count >= 3) continue;
        counts.set(row.session_id, count + 1);
        if (offset++ < query.offset) continue;
        const pattern = new RegExp(
          terms
            .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "giu",
        );
        let start = Math.max(0, (pattern.exec(row.text)?.index ?? 0) - 50);
        if (start > 0 && /[\uDC00-\uDFFF]/.test(row.text[start] ?? "")) start--;
        const snippet = row.text.slice(
          start,
          start + Math.max(160, query.q.length + 50),
        );
        pattern.lastIndex = 0;
        hits.push({
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          directory: row.directory,
          archived: row.time_archived !== null,
          messageId: row.message_id,
          partId: row.part_id,
          role: row.role,
          createdAt: row.created_at,
          snippet,
          highlights: Array.from(snippet.matchAll(pattern), (match) => ({
            start: match.index,
            end: match.index + match[0].length,
          })),
        });
        if (hits.length > query.limit) break;
      }
    } finally {
      candidates.finalize();
    }
    return {
      results: hits.slice(0, query.limit),
      hasMore: hits.length > query.limit,
      indexing: this.status(),
    };
  }

  stop(): void {
    this.stopped = true;
  }

  close(): void {
    this.source.close();
    this.index.close();
  }
}
