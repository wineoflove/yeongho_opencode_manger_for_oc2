import type { Migration } from '../migration-runner'
import {
  PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE,
  SCHEDULE_RUN_OUTCOME_COLUMNS,
} from './202610181319-preserve-fork-schedule-outcomes'

interface ColumnInfo {
  name: string
}

/**
 * Adds the reported outcome, usage snapshot and agent columns to `schedule_runs`, then restores
 * any values `202610181319-preserve-fork-schedule-outcomes` kept across the table rebuild.
 */
const migration: Migration = {
  id: '202611041200-schedule-run-outcome',

  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(schedule_runs)').all() as ColumnInfo[]).map((column) => column.name),
    )
    if (columns.size === 0) {
      return
    }
    for (const column of SCHEDULE_RUN_OUTCOME_COLUMNS) {
      if (!columns.has(column)) {
        db.run(`ALTER TABLE schedule_runs ADD COLUMN ${column} TEXT`)
      }
    }

    const preserved = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE)
    if (!preserved) {
      return
    }
    db.run(`
      UPDATE schedule_runs
      SET outcome = kept.outcome,
          outcome_json = kept.outcome_json,
          usage_json = kept.usage_json,
          agent_used = kept.agent_used
      FROM ${PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE} AS kept
      WHERE schedule_runs.id = kept.run_id
    `)
    db.run(`DROP TABLE ${PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE}`)
  },

  down(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(schedule_runs)').all() as ColumnInfo[]).map((column) => column.name),
    )
    for (const column of SCHEDULE_RUN_OUTCOME_COLUMNS) {
      if (columns.has(column)) {
        db.run(`ALTER TABLE schedule_runs DROP COLUMN ${column}`)
      }
    }
  },
}

export default migration
