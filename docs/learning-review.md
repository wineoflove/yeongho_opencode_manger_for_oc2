# Daily and weekly learning review

## Analysis Usage and Scheduled Outcomes

`run.mjs` includes `analysisUsage` in its JSON result for done, already-reviewed, and failed paths. It is null when no usage was collected, including empty batches and publication-only retries. Otherwise it contains input, output, reasoning, cacheRead, cacheWrite, cost, and a provider/model `models` breakdown from assistant messages in the temporary analysis session.

The analysis transport captures usage before aborting and deleting that session. On an analysis failure it tries to read usage once more and attaches it to the error. This is best-effort accounting, not proof that analysis or delivery succeeded; a null value doesn't establish zero cost.

The scheduled wrapper, not `run.mjs`, should call `ocm` with `action: report_outcome` near the end. Report the actual task outcome and delivery state, with processed/remaining counts when known. Forward non-null `analysisUsage` unchanged as `params.additionalUsage`, because the deleted analysis session won't appear in the run's termination snapshot. Don't add usage already counted in the run session tree.

Only the session directly linked to a still-running schedule can report. A child analysis session can't report for its wrapper. A completed wrapper with no report becomes unreported, not succeeded. Report once as a convention; repeated reports while running replace the previous report and increment its count. See [Agent Tasks Operations](agent-tasks.md) for fields, limits, and error handling.

## 승인된 반영 추적과 주간 지침 관리 (2026-10-19)

사용자는 기존 daily/weekly wrapper의 안전한 수정·검증을 넘어 실제 반영 이력과 기존 지침의 전체 리뷰·수정·통합·삭제를 승인했다. 절차는 `workspace/repos/assistant/.opencode/docs/learning-follow-through.md`, CLI는 [learning-application.md](learning-application.md)다. `verified`는 근거 확인이며 적용 완료가 아니다. 별도 applications 원장이 파일 반영·검사·runtime 대기를 추적한다. 원래 학습은 보존한다. 운영 배포/재시작·권한/모델/자격증명 변경·설치·commit/push는 별도 승인이다. 예약 prompt 저장은 다음 자동 실행 성공의 증거가 아니다.

모든 프로젝트는 전역 `workspace/.opencode/learnings`를 공유한다. 분석 단계는 등록된 세션·학습·지침을 읽고 pending 후보와 제안을 생성한다. 별도 wrapper가 적용 필요성을 판단하고 승인된 범위의 변경과 증거 보존을 수행한다. 분석 모델은 도구 금지 상태를 유지한다.

## Execution

Install the automation script dependencies once with `pnpm --dir scripts install --frozen-lockfile`. `scripts/` is its own pnpm root, so the main workspace settings and lockfile do not apply to it.

Run `bun --no-env-file scripts/learning-review/run.mjs daily` or `weekly` once from this repository. Configuration is in the global store's `review-config.json`. Existing jobs run daily at 03:00 and Monday at 04:00 Asia/Seoul; their current model/permission/time settings are preserved by this change. An empty daily batch skips the additional analysis call, not the wrapper. The model timeout remains 180 seconds.

Daily collection starts at the previous checkpoint (initially a 24-hour lookback), examines at most 300 message rows and includes at most 30 eligible messages. Only completed assistant messages or user messages are considered. Text/tool evidence is truncated and redacted before analysis; these excerpts cannot independently prove full test coverage or semantic correctness. Long active sessions are processed incrementally. Older initial history is intentionally not backfilled. Reports disclose remaining scanned backlog.

Review analysis sessions, the dedicated feedback session, these two jobs and descendants are excluded from daily collection. Weekly collection now reads all learning entries with complete Conditions/Evidence/Limits, application states and every section of the allowlisted current instruction files. It has no seven-day or thirty-file filter and does not re-amplify daily summary claims as independent evidence. The complete input has a 1 MiB safety bound; exceeding it fails explicitly rather than silently claiming full review. The weekly batch identity includes content hashes, so same-day policy changes are not treated as an already-reviewed identical batch. Model policyFindings are source-validated proposals; actual section coverage is tracked by the wrapper's separate review receipt.

## Persistence and safety

`state/reviews.sqlite` owns the daily cursor, batch receipts, publishing outbox, deduplication keys and a 15-minute shared lease. Model analysis is bounded to 180 seconds with tools denied. Source material is untrusted data. Results are schema-checked and source references must exist in the collected batch. Every new entry is pending, never automatically verified.

The cursor advances only after feedback delivery. Prepared reports retry publication before new collection, using stable message IDs and a read-before-retry check. Rejected analysis or delivery failure retains the old cursor. Lease overlap is rejected; expired leases can be reclaimed. This is local operational coordination, not a sandbox against same-user processes. Redaction is best-effort, not a guarantee for all secret formats; raw transcripts are never intentionally exported to reports or GitHub.

The dedicated session receives report messages with `noReply=true`: viewing a report does not start another model turn. Reports include reviewed count, pending candidates, repeated issues, uncertainties and improvement proposals. Errors are posted where possible and also remain in the OCM scheduled run and local receipt. If the API is unavailable, immediate feedback cannot be guaranteed; pending publication is retried on the next run.

The analysis subprocess cannot edit. The approved primary wrapper may apply scoped product changes and maintain mutable instruction text, preserving before snapshots, evidence and per-section reasons. Protected authority/security boundaries remain unchanged. Original learning deletion, credential access, public posting, push and service restarts are not authorized. Existing verified records remain subject to conditions and are assessed for adoption just like pending records. Missing old incident details must not indefinitely block an independently justified current improvement.

## Execution-session cleanup

The user subsequently approved cleanup of disposable execution sessions. On the Mac mini deployment the non-model LaunchAgent `io.wineoflove.ocm.learning-cleanup` is configured to run `cleanup.mjs` at load and every 3600 seconds (`StartInterval`); the earlier Linux deployment used the systemd user timer `ocm-learning-review-cleanup.timer` every five minutes. It targets only the two IDs in `cleanupJobIds` (daily, weekly order), ignores runs finished before `cleanupEnabledAt`, requires a completed schedule run older than one minute, parses its successful batch receipt, verifies a done ledger entry and an exact matching report message in the permanent feedback session, and skips active/reused sessions, children and pending permission/question cases. Deletion receipts are retained locally. OCM schedule-run history and learning reports remain; the associated disposable OpenCode session is deleted.

Failed or unconfirmed runs are retained for diagnosis, even when the OCM wrapper itself finished successfully. The permanent feedback session is explicitly excluded. No analysis or extra OpenCode session is created by the cleanup job. A user resuming a completed execution session concurrently with deletion is not transactionally locked across services; a grace interval and repeated activity checks reduce, but cannot eliminate, that race. Use the permanent feedback session rather than completed schedule execution sessions for follow-up discussion.

## Tests

From `scripts/learning-review`, run `bun --no-env-file test .`. New application tests cover verified-without-adoption, failed/missing checks, source drift, concurrent revisions, aliases, protected rules and full weekly section coverage. Existing tests continue to cover daily exclusion, redaction and report delivery. CLI fixture tests are not a live scheduled-run/deployment verification.
