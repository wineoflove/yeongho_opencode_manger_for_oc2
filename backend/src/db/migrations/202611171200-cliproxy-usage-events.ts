import type { Migration } from "../migration-runner";

export const cliproxyUsageEventsMigration: Migration = {
  id: "202611171200-cliproxy-usage-events",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS cliproxy_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL UNIQUE,
        request_id TEXT,
        occurred_at INTEGER NOT NULL,
        auth_index TEXT NOT NULL,
        account_label TEXT,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        executor_type TEXT,
        model TEXT,
        alias TEXT,
        response_model TEXT,
        session_id TEXT,
        failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
        failure_status INTEGER,
        stream INTEGER,
        latency_ms INTEGER,
        accounting_version INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        breakdown_quality TEXT,
        collected_at INTEGER NOT NULL
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_cliproxy_usage_events_time ON cliproxy_usage_events (provider, occurred_at)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_cliproxy_usage_events_session ON cliproxy_usage_events (session_id)",
    );
  },
  down(db) {
    db.run("DROP TABLE IF EXISTS cliproxy_usage_events");
  },
};
