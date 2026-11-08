import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migration-runner";
import { allMigrations } from "../../src/db/migrations";
import {
  listLatestScheduleRunsPerJob,
  listScheduleRunsForOverview,
} from "../../src/db/schedules";
import type { ScheduleOutcomeReport } from "@opencode-manager/shared/schemas";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

const report: ScheduleOutcomeReport = {
  outcome: "partial",
  summary: "Processed 3 of 5 items",
  processed: 3,
  remaining: 2,
  unit: "items",
  reportedAt: NOW,
  agent: "sisyphus",
  reportCount: 1,
};

interface RunSeed {
  id: number;
  jobId: number;
  status: string;
  startedAt: number;
  repoId?: number | null;
  outcomeJson?: string | null;
  logText?: string | null;
}

function insertRun(db: Database, seed: RunSeed): void {
  db.prepare(
    `INSERT INTO schedule_runs (id, job_id, repo_id, trigger_source, status, started_at, created_at, outcome_json, log_text, response_text)
     VALUES (?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.jobId,
    seed.repoId === undefined ? 1 : seed.repoId,
    seed.status,
    seed.startedAt,
    seed.startedAt,
    seed.outcomeJson ?? null,
    seed.logText ?? null,
    seed.logText ?? null,
  );
}

describe("schedule overview run queries", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, allMigrations);
  });

  it("lists overview runs since a bound plus older running runs without large text", () => {
    insertRun(db, {
      id: 1,
      jobId: 1,
      status: "completed",
      startedAt: NOW - 10 * DAY,
      logText: "old",
    });
    insertRun(db, {
      id: 2,
      jobId: 1,
      status: "running",
      startedAt: NOW - 9 * DAY,
      logText: "stuck",
    });
    insertRun(db, {
      id: 3,
      jobId: 2,
      status: "failed",
      startedAt: NOW - DAY,
      logText: "recent",
      repoId: null,
    });

    const runs = listScheduleRunsForOverview(db, NOW - 7 * DAY);
    expect(runs.map((run) => run.id)).toEqual([3, 2]);
    expect(
      runs.every((run) => run.logText === null && run.responseText === null),
    ).toBe(true);
    expect(runs[0]?.repoId).toBeNull();
  });

  it("returns latest, latest reported and latest terminal runs per job regardless of age", () => {
    insertRun(db, {
      id: 1,
      jobId: 1,
      status: "completed",
      startedAt: NOW - 30 * DAY,
      outcomeJson: JSON.stringify(report),
      logText: "x",
    });
    insertRun(db, {
      id: 2,
      jobId: 1,
      status: "failed",
      startedAt: NOW - 20 * DAY,
    });
    insertRun(db, {
      id: 3,
      jobId: 1,
      status: "running",
      startedAt: NOW - 10 * DAY,
    });
    insertRun(db, {
      id: 4,
      jobId: 2,
      status: "running",
      startedAt: NOW - 15 * DAY,
    });

    const latest = listLatestScheduleRunsPerJob(db);
    const jobOne = latest.get(1);
    expect(jobOne?.latest?.id).toBe(3);
    expect(jobOne?.latestReported?.id).toBe(1);
    expect(jobOne?.latestReported?.outcomeReport).toEqual(report);
    expect(jobOne?.latestReported?.logText).toBeNull();
    expect(jobOne?.latestTerminal?.id).toBe(2);

    const jobTwo = latest.get(2);
    expect(jobTwo?.latest?.id).toBe(4);
    expect(jobTwo?.latestReported).toBeNull();
    expect(jobTwo?.latestTerminal).toBeNull();
  });
});
