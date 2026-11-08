import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from '../../shared/src/zod.ts'
import { collect, digest, redact } from './data.mjs'
import { Analysis, validateAnalysis, formatReport, failureNotice } from './contracts.mjs'
import { analyze, publish } from './transport.mjs'
import { DELIVERY_MODES } from './report-delivery.mjs'
import { loadEntries } from './search-entries.mjs'

const Config = z.object({
  store: z.string(),
  opencodeDb: z.string(),
  managerDb: z.string(),
  reposRoot: z.string(),
  directory: z.string(),
  feedbackSession: z.string().regex(/^ses_/),
  delivery: z.enum(DELIVERY_MODES),
  models: z.object({ daily: z.string(), weekly: z.string() }),
})
const mode = z.enum(['daily', 'weekly']).parse(process.argv[2])
const config = Config.parse(
  JSON.parse(
    await readFile(
      process.env.LEARNING_REVIEW_CONFIG ||
        join(process.env.WORKSPACE_PATH || new URL('../../workspace', import.meta.url).pathname, '.opencode/learnings/review-config.json'),
      'utf8',
    ),
  ),
)
for (const folder of ['state', 'entries', 'reviews/daily', 'reviews/weekly'])
  await mkdir(join(config.store, folder), { recursive: true, mode: 0o700 })
process.umask(0o077)
const db = new Database(join(config.store, 'state', 'reviews.sqlite'))
db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS cursor (mode TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, started INTEGER NOT NULL, status TEXT NOT NULL,
    batch TEXT NOT NULL, analysis TEXT, report TEXT, message_id TEXT NOT NULL, error TEXT);
  CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, file TEXT NOT NULL);`)
const token = randomUUID()
const locked = db.transaction(() => {
  const active = db.query('SELECT expires FROM lease WHERE id=1').get()
  if (active && active.expires > Date.now()) return false
  db.query('INSERT OR REPLACE INTO lease VALUES(1,?,?)').run(token, Date.now() + 15 * 60000)
  return true
})()
if (!locked) {
  db.close()
  throw new Error('Another daily or weekly review holds the lease')
}
const fence = () => {
  const lease = db.query('SELECT token,expires FROM lease WHERE id=1').get()
  if (lease?.token !== token || lease.expires <= Date.now()) throw new Error('Review lease expired or changed')
}
let run
let analysisUsage = null
let rawAnalysis = null
try {
  run = db.query("SELECT * FROM runs WHERE mode=? AND status='publishing' ORDER BY started LIMIT 1").get(mode)
  if (!run) {
    const until = Date.now() - 60000
    const saved = db.query('SELECT value FROM cursor WHERE mode=?').get(mode)
    const cursor = saved ? JSON.parse(saved.value) : { time: until - 86400000, id: '' }
    const batch = await collect(config, mode, cursor, until)
    const day = new Date(until).toISOString().slice(0, 10)
    const id = digest([
      mode,
      batch.records.map((r) => r.id),
      mode === 'weekly' || !batch.records.length ? day : cursor,
      batch.contentDigest ?? null,
    ]).slice(0, 24)
    const previous = db.query('SELECT * FROM runs WHERE id=?').get(id)
    if (previous?.status === 'done') {
      process.stdout.write(`${JSON.stringify({ status: 'already-reviewed', mode, batch: id, analysisUsage })}\n`)
    } else {
      const started = previous?.started || Date.now()
      const messageID =
        previous?.message_id || `msg_${((BigInt(started) << 12n) + 1n).toString(16).slice(-12)}${id.slice(0, 14)}`
      db.query(
        "INSERT OR REPLACE INTO runs(id,mode,started,status,batch,message_id) VALUES(?,?,?,'analyzing',?,?)",
      ).run(id, mode, started, JSON.stringify(batch), messageID)
      run = db.query('SELECT * FROM runs WHERE id=?').get(id)
      const loaded = await loadEntries(join(config.store, 'entries'))
      if (Object.values(loaded.skipped).some((count) => count > 0)) throw new Error('Incomplete learning inventory')
      const existing = loaded.entries.map(({ id, patternKey, status, related }) => ({
        id,
        patternKey,
        status,
        related,
      }))
      let analysis
      if (batch.records.length) {
        const result = await analyze(config, mode, batch.records, existing)
        analysisUsage = result.usage
        rawAnalysis = result.analysis
        analysis = validateAnalysis(result.analysis, batch.records)
      } else {
        analysis = Analysis.parse({
          summary: '새로 검토할 자료가 없어 추가 분석 모델 호출을 생략했습니다.',
          recurring: [],
          uncertainties: [],
          suggestions: [],
          lessons: [],
        })
      }
      if (mode === 'weekly') analysis.lessons = []
      fence()
      let created = 0
      for (const lesson of analysis.lessons) {
        const key = digest([lesson.patternKey, [...lesson.sourceIds].sort()])
        if (db.query('SELECT id FROM lessons WHERE id=?').get(key)) continue
        const filename = `${new Date(started)
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}Z$/, 'Z')}-${key.slice(0, 12)}.md`
        const entry = `# ${lesson.patternKey}\nID: ${filename.slice(0, -3)}\nPattern-Key: ${lesson.patternKey}\nStatus: pending\nKind: ${lesson.kind}\nObserved-At: ${new Date(started).toISOString()}\nSource: batch ${id}; ${lesson.sourceIds.join(', ')}\nConditions: ${lesson.conditions}\nEvidence: ${lesson.evidence}\nRelated: none\n\n## Lesson\n${lesson.lesson}\n\n## Limits\nBatch evidence is bounded; requires independent verification. ${lesson.limits}\n`
        try {
          await writeFile(join(config.store, 'entries', filename), redact(entry), { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        db.query('INSERT OR IGNORE INTO lessons VALUES(?,?)').run(key, filename)
        created++
      }
      const date = `${new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Seoul',
      }).format(started)} KST`
      const report = `${formatReport(mode, batch, analysis, date, created)}\n분석 모델: ${config.models[mode]}\n`
      await writeFile(join(config.store, 'reviews', mode, `${id}.md`), report, { mode: 0o600 })
      db.query("UPDATE runs SET status='publishing',analysis=?,report=? WHERE id=?").run(
        JSON.stringify(analysis),
        report,
        id,
      )
      run = db.query('SELECT * FROM runs WHERE id=?').get(id)
    }
  }
  if (run?.status === 'publishing') {
    fence()
    await publish(config, run.message_id, run.report)
    fence()
    db.transaction(() => {
      const batch = JSON.parse(run.batch)
      if (batch.cursor) db.query('INSERT OR REPLACE INTO cursor VALUES(?,?)').run(mode, JSON.stringify(batch.cursor))
      db.query("UPDATE runs SET status='done',error=NULL WHERE id=?").run(run.id)
    })()
    process.stdout.write(
      `${JSON.stringify({
        status: 'done',
        mode,
        batch: run.id,
        feedbackSession: config.feedbackSession,
        analysisUsage,
      })}\n`,
    )
  }
} catch (error) {
  const detail = redact(error instanceof Error ? error.message : String(error)).slice(0, 500)
  let failedAnalysis = null
  if (run) {
    db.query(
      "UPDATE runs SET status=CASE WHEN status='publishing' THEN status ELSE 'failed' END,error=? WHERE id=?",
    ).run(detail, run.id)
    const raw = rawAnalysis ?? error?.analysisText ?? null
    if (raw !== null) {
      try {
        failedAnalysis = join('reviews', mode, `${run.id}-failed-${Date.now()}.json`)
        await writeFile(
          join(config.store, failedAnalysis),
          redact(JSON.stringify({ error: detail, analysis: raw }, null, 2)),
          { flag: 'wx', mode: 0o600 },
        )
      } catch (writeError) {
        failedAnalysis = null
        process.stderr.write(`Failed analysis was not saved: ${redact(String(writeError)).slice(0, 200)}\n`)
      }
    }
    const notice = failureNotice(mode, run.id, failedAnalysis ? `${detail}\n\n분석 원문: ${failedAnalysis}` : detail)
    try {
      await publish(config, notice.messageID, notice.text)
    } catch (publishError) {
      process.stderr.write(`Feedback delivery also failed: ${redact(String(publishError)).slice(0, 200)}\n`)
    }
  }
  process.stderr.write(`${detail}\n`)
  process.stdout.write(
    `${JSON.stringify({
      status: 'failed',
      mode,
      batch: run?.id ?? null,
      failedAnalysis,
      analysisUsage: error?.analysisUsage ?? analysisUsage,
    })}\n`,
  )
  process.exitCode = 1
} finally {
  db.query('DELETE FROM lease WHERE id=1 AND token=?').run(token)
  db.close()
}
