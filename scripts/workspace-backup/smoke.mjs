import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeErrorStatus } from "../../shared/src/opencode/index.ts";
import { openCodeApi } from "../learning-review/opencode.mjs";
import { Config, configPath } from "./run.mjs";
import { lifecycle, successMarker } from "./lifecycle.mjs";

if (process.argv[2] !== "--live")
  throw new Error(
    "Use --live to create one disposable QA session and publish its test report",
  );
const config = Config.parse(JSON.parse(await readFile(configPath, "utf8")));
const api = openCodeApi();
const folder = await mkdtemp(join(tmpdir(), "workspace-backup-smoke-"));
const started = Date.now();
const session = await api.session.create({
  title: "[Workspace backup QA] Disposable lifecycle test; no backup performed",
  location: { directory: config.directory },
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
});
try {
  const finished = Date.now();
  const settings = {
    ...config,
    managerDb: join(folder, "manager.sqlite"),
    ledger: join(folder, "receipts.sqlite"),
    enabledAt: started,
  };
  const database = new Database(settings.managerDb);
  database.exec(`CREATE TABLE schedule_jobs(id INTEGER,repo_id INTEGER,name TEXT);
    INSERT INTO schedule_jobs VALUES(${config.jobId},0,'workspace-config-backup');
    CREATE TABLE schedule_runs(id INTEGER,job_id INTEGER,repo_id INTEGER,started_at INTEGER,finished_at INTEGER,
      status TEXT,session_id TEXT,session_title TEXT,response_text TEXT,error_text TEXT);`);
  database
    .query("INSERT INTO schedule_runs VALUES(?,?,0,?,?,'completed',?,?,?,NULL)")
    .run(
      started,
      config.jobId,
      started,
      finished,
      session.id,
      session.title,
      `LIVE LIFECYCLE QA ONLY. Synthetic schedule row in an isolated temporary database, not a real backup run. No Git commands or backup performed. Tests exact report publication and deletion of this newly created empty QA session only. Grace clock is advanced in this test only.\n${successMarker}`,
    );
  database.close();
  const result = await lifecycle(settings, api, finished + config.graceMs + 1);
  if (!result.removed.includes(session.id))
    throw new Error(
      `Live QA retained ${session.id}: ${JSON.stringify(result)}`,
    );
  const lookup = await api.session
    .get({ sessionID: session.id })
    .catch((error) => error);
  const missing = openCodeErrorStatus(lookup) === 404;
  if (!missing) throw new Error("Deleted QA session still exists");
  const receipt = new Database(settings.ledger, { readonly: true });
  const proof = receipt
    .query("SELECT message_id,delivered_at,deleted_at FROM reports")
    .get();
  receipt.close();
  process.stdout.write(
    `${JSON.stringify({ ...result, reportSession: config.feedbackSession, delivery: config.delivery, proof, confirmed404: missing })}\n`,
  );
} finally {
  await rm(folder, { recursive: true, force: true });
}
