import type { Migration } from '../migration-runner'

interface ColumnInfo {
  name: string
}

export const SCHEDULE_RUN_OUTCOME_COLUMNS = ['outcome', 'outcome_json', 'usage_json', 'agent_used'] as const

export const PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE = 'preserved_schedule_run_outcomes'

/**
 * Copies schedule run outcome columns from databases created by the Manager fork before
 * `202610181320-remote-schedule-targets` rebuilds `schedule_runs` with a fixed column list.
 * `202611041200-schedule-run-outcome` restores the copy and removes the table.
 */
const migration: Migration = {
  id: '202610181319-preserve-fork-schedule-outcomes',

  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(schedule_runs)').all() as ColumnInfo[]).map((column) => column.name),
    )
    const present = SCHEDULE_RUN_OUTCOME_COLUMNS.filter((column) => columns.has(column))
    if (present.length === 0) {
      return
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS ${PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE} (
        run_id INTEGER PRIMARY KEY,
        outcome TEXT,
        outcome_json TEXT,
        usage_json TEXT,
        agent_used TEXT
      )
    `)
    const selected = SCHEDULE_RUN_OUTCOME_COLUMNS.map((column) => (columns.has(column) ? column : 'NULL')).join(', ')
    const anyValue = present.map((column) => `${column} IS NOT NULL`).join(' OR ')
    db.run(`
      INSERT OR REPLACE INTO ${PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE} (run_id, outcome, outcome_json, usage_json, agent_used)
      SELECT id, ${selected} FROM schedule_runs WHERE ${anyValue}
    `)
  },

  down(db) {
    db.run(`DROP TABLE IF EXISTS ${PRESERVED_SCHEDULE_RUN_OUTCOMES_TABLE}`)
  },
}

export default migration
