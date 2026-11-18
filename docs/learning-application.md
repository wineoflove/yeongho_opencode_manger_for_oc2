# 학습 반영 CLI와 근거 계약

cwd는 Manager 루트다. 새 패키지·서버 배포 없이 기존 Bun과 scripts의 Zod를 사용한다. `entries/Status`와 별개로 반영 이력을 전역 store의 applications에 저장한다. 설정은 `workspace/.opencode/learnings/application-config.json`이며 `--config`는 격리 fixture용이다. 원래 데이터는 자동 이관/승격하지 않는다.

## 명령

```sh
bun --no-env-file scripts/learning-review/applications.mjs prepare --mode daily
bun --no-env-file scripts/learning-review/applications.mjs prepare --mode weekly
bun --no-env-file scripts/learning-review/applications.mjs status
bun --no-env-file scripts/learning-review/applications.mjs snapshot --path /absolute/target.md
bun --no-env-file scripts/learning-review/applications.mjs readback --path /absolute/target.md --scope '확인한 구체적 요구사항'
bun --no-env-file scripts/learning-review/applications.mjs verify --input /absolute/check-request.json
bun --no-env-file scripts/learning-review/applications.mjs record --input /absolute/decision.json
bun --no-env-file scripts/learning-review/applications.mjs review --input /absolute/weekly-review.json
bun --no-env-file scripts/learning-review/applications.mjs claims --path /absolute/target --self ses_current
bun --no-env-file scripts/learning-review/applications.mjs runtime-probe --path /absolute/agents/name.md
bun --no-env-file scripts/learning-review/applications.mjs runtime-sync
```

`claims`는 OpenCode 세션 DB를 읽기 전용으로 열어 최근 24시간 대상 파일을 edit/write/apply_patch로 다룬 세션을 찾고, 현재 실행 계보(자기 세션·부모·자식)를 제외한 뒤 지금 busy이거나 30분 이내 편집한 세션만 conflicts로 반환한다. directory에 무관한 busy 세션이 있다는 사실만으로는 충돌이 아니다.

`runtime-probe`는 실행 중 서버의 `/agent` 또는 `/skill`이 제공하는 본문과 파일 본문(frontmatter 제외)을 대조해 `origin: runtime-probe` receipt를 남긴다. 일치하지 않으면 exitCode 2다. `runtime-sync`는 applied·runtime pending 항목을 로딩 방식으로 분류한다: agent/skill은 probe 일치 시 verified, 불일치 시 reloadPending(서버 재시작 전 정상 상태, 기록 변경 없음), AGENTS.md·정책 문서·학습 리뷰 스크립트는 파일에서 매번 다시 읽히므로 not_required, 그 밖의 제품 코드는 배포 확인이 필요해 pending(unsupported)으로 남긴다. 모두 읽기 전용이며 reload/restart를 하지 않는다. 설정의 `runtime`(api, directory, sessionDb)이 필요하다.

prepare가 반환한 manifest를 읽고 실제로 대상 소스와 원문을 확인한다. raw policy snapshot은 로컬 0600으로 보존되며 분석에는 sanitize된 사본만 사용한다. config의 정책 파일만 예외로 .config/.opencode 경로를 허용한다. 소스 대상은 codeRoots 안의 지정 확장자로 제한하고 의존성·산출물·인증 파일을 제외한다. 코드 대상은 whole-file hash가 달라지면 drifted로 보수적으로 재검토한다. 정책 대상에 `anchor`(반영한 규칙의 정확한 문구)를 기록하면 그 문구를 포함한 규칙 줄과 소속 heading의 해시를 함께 저장한다. anchor는 코드 블록 밖에서 정확히 한 줄에만 있어야 한다. 그 줄의 내용이 앞뒤 조건까지 포함해 바뀌거나, 다른 구간·코드 블록으로 옮겨지거나, 사라지면 drifted가 된다. 따라서 같은 지침 파일의 무관한 수정이 모든 반영 기록을 재검토 대기열로 되돌리지 않는다. anchor가 없는 정책 대상은 계속 whole-file hash로 판정한다.

Python 대상: snapshot은 `.py`·`.toml`을 허용하고 `.venv`·`__pycache__`는 거절한다. verify 실행기는 `python3`(`-c` 금지)와 `ruff`(`check` 또는 `--check` 필수)를 추가로 허용하며, test marker는 `unittest`/`pytest`, lint marker는 `ruff`다. `-p`는 node 출력 옵션 차단 때문에 거절되므로 unittest에는 `--pattern`을 쓴다. `pip`·`sync`·`lock`·`--fix`·`--write`·`--unsafe-fixes`는 모든 실행기에서 거절된다.

## 실행 receipt

```json
{
  "argv": ["bun", "--no-env-file", "test", "./application-store.test.mjs"],
  "cwd": "/Users/yeonghokim/apps/ocm-v2-staging/port/scripts/learning-review",
  "kind": "test",
  "scope": "반영 상태 전이와 실패 경계",
  "targets": ["/Users/yeonghokim/apps/ocm-v2-staging/port/scripts/learning-review/application-store.mjs"]
}
```

kind는 보통 test/typecheck/lint/build다. 별도 승인된 외부 유지보수의 runtime 확인은 kind=runtime, 승인 원문을 보존한 approvalEvidence 및 읽기 전용 검증 script의 --check가 필요하다. 자동 wrapper가 이 승인을 만들어서는 안 된다. 실제 child process를 shell 없이 실행하며 허용된 실행기·종류를 확인한다. 이 제한은 sandbox가 아니다. 테스트 코드가 외부 서비스를 호출하거나 임시 서버를 제어할 수 있으므로 실행 전 소스·fixture·package scripts를 읽어야 한다. 설치·배포 명령은 거절한다. timeout·출력 잘림·대상 변경이면 applied로 사용할 수 없다. readback은 파일 전체 읽기만 확인하며 코드 검증이나 운영 확인을 대체하지 않는다.

## 반영 판단 입력

```json
{
  "patternKey": "workflow.global-learning",
  "entryIds": ["원래 학습 ID"],
  "expectedRevision": 0,
  "decision": "applied",
  "summary": "정확한 반영 내용",
  "rationale": "원문과 현행 소스를 대조한 이유",
  "evidence": ["reviews/근거.md"],
  "targets": [
    {
      "snapshot": "applications/snapshots/실제파일.json",
      "afterHash": "현재 파일 SHA-256 64자리",
      "change": "modified",
      "requirement": "이 파일에서 확인한 구체적인 요구사항"
    }
  ],
  "checks": [
    {
      "kind": "test",
      "command": "receipt.command 원문",
      "cwd": "/정확한/cwd",
      "exitCode": 0,
      "scope": "receipt.scope 원문",
      "evidence": "applications/checks/실제파일.json"
    }
  ],
  "runtime": { "status": "pending", "reason": "운영 적용은 별도 승인 대기", "evidence": [] }
}
```

기존 구현 확인은 change=existing이고 before/after 해시가 같아야 한다. modified는 달라야 한다. `anchor`는 config에 등록된 정책 대상에만 허용되며 기록 시 현재 파일의 코드 블록 밖 한 줄에만 존재해야 한다(ANCHOR_POLICY_ONLY, ANCHOR_NOT_FOUND, ANCHOR_NOT_UNIQUE). 상태는 drifted > source_changed > evidence_changed > 기록된 decision 순서로 하나만 표시한다. 여러 학습이 같은 파일 변경을 공유할 때는 같은 snapshot/afterHash를 쓰고 각자의 규칙 문구를 anchor로 둔다. block에는 unblockWhen이 필수다. planned/blocked/not_applicable/retired도 구체적 이유와 저장된 근거를 요구한다. source 해시는 같은 canonical pattern의 기록을 묶으며 aliases는 확인된 중복 사건만 설정한다. 원래 entries는 바꾸지 않는다. record는 단일 writer lock과 expectedRevision으로 충돌을 거절하고 event를 추가한다. stale lock은 자동 탈취/삭제하지 않는다.

검사 receipt와 각 대상 파일 해시를 검증하지만 의미적 요구사항 충족이나 부작용 부재를 자동 증명하지는 않는다. 저장된 근거가 바뀌면 evidence_changed로 재평가한다. 로컬 store를 임의로 쓰는 같은 사용자에 대한 서명/보안 경계도 아니다. 운영 적용은 별도 실제 근거가 필요하며 이 CLI가 서비스를 재시작하지 않는다.

## 주간 전체 구간 리뷰

```json
{
  "manifest": "applications/plans/실제주간manifest.json",
  "decisions": [
    {
      "sectionId": "manifest의 정확한 구간 ID",
      "decision": "keep",
      "reason": "사용자 의도·현행 계약에 유효한 구체적 이유",
      "evidence": ["applications/plans/실제주간manifest.json"]
    }
  ],
  "addedSections": []
}
```

모든 원래 구간을 정확히 한 번 포함한다. change/remove에는 applicationEvent가 필수이며, 최종 파일 해시와 변경 전 해시가 기록과 일치해야 한다. 순서 변경처럼 모든 구간 내용이 같아도 파일 해시가 바뀌면 원래 구간 결정 중 하나에 해당 applicationEvent를 연결해야 한다. 후속 existing 확인이 추가되어도 이전 변경 event는 전체 이력에서 참조할 수 있다. 구간 ID는 정책 ID·heading·중복 순번에 기반하므로 heading 변경은 old remove/new addedSections로 기록한다. 새 구간도 reason과 applicationEvent가 필요하다. protected 구간의 문구·들여쓰기 변경과 readonly 파일 변경은 거절한다. 자동 formatter의 빈 줄 추가/제거만 내용 동일로 취급하되 전체 파일 해시 변화는 여전히 event가 필요하다. 변경·삭제는 지침 텍스트에만 적용하며 파일 전체 삭제는 지원하지 않는다.

defer가 있으면 status=partial, 모두 판단되고 변경 연결이 유효하면 reviewed다. reviewed는 구조적 커버리지 검증이지 정책 내용이 절대적으로 옳거나 runtime 적용됐다는 뜻이 아니다. 지침 변경은 별도 독립 내용 검토를 거치며 사용자 선호·안전 경계의 불확실성은 defer한다.
