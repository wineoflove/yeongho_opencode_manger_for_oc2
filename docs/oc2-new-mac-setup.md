# OC2 새 Mac 설치 가이드

맥미니에서 운영 중인 OC2 환경을 다른 Mac(Apple Silicon)에 같은 구성으로 설치하는 절차입니다. 2026-11-26 맥미니 상태를 기준으로 작성했습니다.

설치 범위:

1. OC2 커스텀(native) + OCM(Manager) 포크. 이후 업데이트할 수 있도록 각 리포지토리를 `origin`·`upstream`으로 연결합니다.
2. CLIProxy + Headroom 연결
3. 학습 일일·주간 리뷰 스케줄. 버전 점검과 설정 백업 스케줄은 선택입니다.
4. 주요 MCP 서버와 스킬

옮기지 않는 것: 세션·대화 이력(native DB), Manager DB의 세션 기록, 맥미니의 CLIProxy 로그인 토큰, OpenClaw, Cloudflare Tunnel(`opencode2.wineoflove.com`), 예약 시스템이나 건강 포털 같은 다른 서비스.

> **경로 전제**: 지침·스크립트·스케줄 프롬프트·MCP 설정에 `/Users/yeonghokim/apps/ocm-v2-staging` 같은 절대경로가 많이 들어 있습니다. 새 Mac에서도 **사용자명을 `yeonghokim`으로 하고 같은 경로를 쓰는 것을 권장합니다.** 다른 사용자명을 써야 한다면 [12. 다른 사용자명일 때](#12-다른-사용자명일-때)를 먼저 읽어 주세요.

---

## 0. 구성 한눈에 보기

```text
브라우저 ─▶ OCM Manager :5106  (launchd io.wineoflove.ocm2.backend, bun backend/dist/index.js)
             ├─ OC2 native :5107  (Manager가 OPENCODE_BIN을 자식 프로세스로 실행)
             │    ├─ openai/*    ─▶ Headroom :18788/v1 ─▶ CLIProxy :5117 ─▶ ChatGPT(Codex) 계정
             │    └─ anthropic/* ─▶ Manager :5106/api/claude-inference/v1 ─▶ Headroom :18788 ─▶ CLIProxy :5117 ─▶ Claude 계정
             └─ preview :5108

OC2 ─▶ MCP  context7 :5121 · firecrawl :5122 · markitdown :5123 · exa :5124   (launchd 공용 서버, ~/apps/mcp-shared)
            ref (원격 https://ref.theseeker.io/mcp)
            playwright · codegraph · claude-design   (OC2가 띄우는 로컬 프로세스)
```

| 구성 요소 | 기준 버전 | 원본 |
| --- | --- | --- |
| OC2 native | `2.4.1-ocm-pool.36` | `wineoflove/yeongho_opencode2` `main` (`8a138733`), upstream `anomalyco/opencode` `v2.4.1` |
| OCM (Manager) | 포크 `main` | `wineoflove/yeongho_opencode_manger_for_oc2`, upstream `chriswritescode-dev/opencode-manager` |
| 워크스페이스 설정·학습 저장소 | `macmini` 브랜치 | `wineoflove/ocm-workspace-config` (비공개) |
| CLIProxyAPI | `8.1.3` | `router-for-me/CLIProxyAPI` GitHub Releases |
| Headroom | `headroom-ai 0.45.0` (Python 3.12) | PyPI |
| Bun | 런타임 `1.4.0`, native 빌드 `1.4.4` | npm `bun` / `oven-sh/bun` Releases |
| pnpm / Node / uv | `10.28.1` / Homebrew `node` (v26) / Homebrew `uv` | |
| MCP | context7 `4.7.3`, firecrawl-mcp `3.41.0`, @playwright/mcp `0.0.85`, markitdown-mcp `0.0.1a8`, codegraph `1.5.0`, claude-design(자체) | |
| 스킬 | 전역 38개 + Manager 생성 5개 | `ocm-workspace-config` |

맥미니에서 확인한 바이너리 SHA-256:

- OC2 `.36` (`artifact-36/cli-darwin-arm64/bin/opencode`): `70d79d6bf6132eb50fd65d1263ba815c4baaaf6449f5d780ddf2d91534084c20`
- `CLIProxyAPI_8.1.3_darwin_aarch64.tar.gz`: `c6eee7e616e3942e4ee279c93fbe7f989a337f91ac5b00665174244ae8b5726f`
- 그 안의 `cli-proxy-api`: `b578f4c19b23cd94f95ff9ccb78dd1f1f2944b87d1737a90a6c09a18685d7f68`

새 Mac의 디렉터리 배치:

```text
~/apps/ocm-v2-staging/            (아래에서 $S)
  port/                           OCM 포크 체크아웃 (Manager 실행 위치)
  opencode/2.4.1-ocm-pool.36/     OC2 native 바이너리
  cliproxy/package/               CLIProxy 실행 패키지 (bin, config.yaml, keys, auths, gate)
  env/staging.env                 Manager 환경변수 (권한 600, 비밀값 포함)
  bin/                            운영 스크립트 (launchd-backend.sh, restart.sh, build/deploy …)
  home/                           Manager 전용 HOME
  data/db/                        Manager DB
  data/workspace/                 WORKSPACE_PATH (아래에서 $W)
    .config/opencode/             OC2 전역 설정·에이전트·스킬·플러그인
    .opencode/learnings/          전역 학습 저장소
    .opencode/tooling/            MCP·LSP·Headroom 등의 설치 위치
    repos/assistant/              Assistant 워크스페이스
    repos/oc2-custom/             OC2 포크 소스 (업데이트용)
~/apps/mcp-shared/                공용 MCP 서버 스크립트·로그
~/apps/ocm-workspace-config.git   워크스페이스 설정 백업 저장소의 git dir (작업 트리 밖)
```

---

## 1. 맥미니에서 옮길 묶음 만들기

Git에 없는 운영 파일과 비밀값은 맥미니에서 묶어 옮깁니다. **맥미니의 일반 터미널**에서 실행합니다. 이 명령들은 파일을 읽기만 하며 서비스는 건드리지 않습니다. 에이전트 셸은 HOME이 Manager 전용 경로여서 `~`가 다르게 풀리므로, 아래 명령은 모두 절대경로를 씁니다.

```bash
U=/Users/yeonghokim
S=$U/apps/ocm-v2-staging
W=$S/data/workspace
T=$W/.opencode/tooling
B=$U/oc2-bundle
mkdir -m 700 "$B"

# (1) 비밀값이 없는 운영 파일. 새 Mac에서 / 기준으로 풀면 같은 경로에 놓입니다.
tar -C / -czf "$B/files.tgz" \
  --exclude '*/.opencode/learnings/state' \
  "${S#/}/bin/launchd-backend.sh" "${S#/}/bin/start.sh" "${S#/}/bin/stop.sh" \
  "${S#/}/bin/restart.sh" "${S#/}/bin/status.sh" \
  "${S#/}/bin/build-oc2.sh" "${S#/}/bin/deploy-oc2-code.sh" \
  "${S#/}/bin/oc2-active.mjs" "${S#/}/bin/cleanup-rr-sessions.mjs" \
  Users/yeonghokim/apps/mcp-shared/README.md Users/yeonghokim/apps/mcp-shared/bin \
  "${T#/}/claude-design-mcp/package.json" "${T#/}/claude-design-mcp/server.mjs" "${T#/}/claude-design-mcp/src" \
  "${T#/}/playwright-mcp" \
  "${T#/}/ui-automation/package.json" "${T#/}/ui-automation/package-lock.json" "${T#/}/ui-automation/bin" \
  "${W#/}/.config/opencode/opencode.jsonc" \
  "${W#/}/repos/assistant/.opencode/bin/schedule-report.mjs" \
  "${W#/}/.opencode/learnings" \
  Users/yeonghokim/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist \
  Users/yeonghokim/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist

# (2) Headroom 의존성 고정 목록 (launchd가 실제로 쓰는 venv 기준)
PY=$(plutil -extract ProgramArguments.0 raw $U/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist)
[ -x "$PY" ] || { echo "Headroom Python을 찾지 못했습니다: '$PY'" >&2; false; }   # 빈 값이면 엉뚱한 환경을 freeze하므로 중단
uv pip freeze --python "$PY" > "$B/headroom-requirements.txt"
grep -E '^(headroom-ai|onnxruntime)==' "$B/headroom-requirements.txt"   # headroom-ai==0.45.0, onnxruntime==1.31.0

# (3) Assistant 스케줄 정의 (Manager DB 읽기 전용)
sqlite3 -readonly -json "$S/data/db/opencode-manager.db" \
  "SELECT id, name, description, enabled, schedule_mode AS scheduleMode,
          cron_expression AS cronExpression, interval_minutes AS intervalMinutes,
          timezone, agent_slug AS agentSlug, model, workspace_mode AS workspaceMode,
          permission_config AS permissionConfig, prompt
     FROM schedule_jobs WHERE repo_id = 0 AND enabled = 1 ORDER BY id" > "$B/schedules.json"

# (4) 현재 OC2 native 바이너리 (빌드를 생략하려면)
OB=$(grep '^OPENCODE_BIN=' "$S/env/staging.env" | cut -d= -f2-)
cp "$OB" "$B/opencode" && shasum -a 256 "$B/opencode"

# (5) 선택: codegraph 실행 파일(인덱스 제외), Headroom이 쓰는 Hugging Face 모델 캐시(약 260MB)
tar -C "$U" -czf "$B/codegraph.tgz" --exclude '.omo/codegraph/projects' .omo/codegraph
tar -C "$U" -czf "$B/huggingface.tgz" .cache/huggingface

# (6) 비밀값. 따로 보관하고 Git·채팅·클라우드 공유 폴더에 올리지 않습니다.
tar -C / -czf "$B/secrets.tgz" \
  Users/yeonghokim/.local/share/opencode-manager/secrets/exa-api-key \
  Users/yeonghokim/.local/share/ocm-migration-20260930/private/mcporter.json
chmod 600 "$B"/*
ls -la "$B"
```

`schedules.json`에는 다음 스케줄이 들어 있습니다.

| 맥미니 ID | 이름 | cron (Asia/Seoul) | 새 Mac에서 |
| --- | --- | --- | --- |
| 5 | 학습 일일 리뷰 | `0 3 * * *` | **필수** |
| 6 | 학습 주간 리뷰 | `0 4 * * 1` | **필수** |
| 7 | 핵심 6종 일일 버전 점검 | `0 6 * * *` | 선택 |
| 9 | 개발환경·MCP·스킬 주간 버전 점검 | `0 6 * * 1` | 선택 |
| 2 | workspace-config-backup | `0 5 * * *` | 선택. 브랜치를 바꿔야 함([9.4](#94-선택-설정-백업-스케줄)) |

묶음은 AirDrop, USB 또는 `rsync -a ~/oc2-bundle/ <새맥>:oc2-bundle/`로 새 Mac의 `~/oc2-bundle`에 옮깁니다. 설치가 끝나면 양쪽에서 `secrets.tgz`를 지웁니다.

`mcporter.json`에는 Firecrawl 외의 키가 함께 들어 있을 수 있습니다. 필요한 값만 옮기고 싶다면 이 파일 대신 [6.1](#61-공용-mcp-서버-context7firecrawlmarkitdownexa)에서 Firecrawl 키만 담은 파일을 직접 만드세요.

---

## 2. 새 Mac 사전 준비

새 Mac의 명령은 기본 셸인 zsh 기준입니다. 이후 절은 아래 공통 변수를 쓰므로, 새 터미널을 열면 먼저 다시 설정하세요.

```bash
S=/Users/yeonghokim/apps/ocm-v2-staging
W=$S/data/workspace
T=$W/.opencode/tooling
G=/Users/yeonghokim/apps/ocm-workspace-config.git
```

```bash
# Xcode Command Line Tools, Homebrew
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install git gh jq node uv sqlite
gh auth login            # wineoflove 계정, HTTPS
gh auth setup-git        # git이 비공개 저장소 clone·push에 gh 인증을 사용

# 런타임 bun / pnpm (맥미니와 같은 위치·버전)
mkdir -p ~/.local/share/ocm-toolchain ~/.local/bin
npm install --prefix ~/.local/share/ocm-toolchain --save-exact bun@1.4.0 pnpm@10.28.1
ln -sf ~/.local/share/ocm-toolchain/node_modules/.bin/{bun,bunx,pnpm,pnpx} ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"' >> ~/.zprofile
exec zsh -l
bun --version; pnpm --version; node --version; uv --version
```

OC2 native 빌드용 Bun 1.4.4입니다. `yeongho_opencode2`의 `packageManager`가 `bun@1.4.4`로 고정되어 있습니다. 바이너리를 맥미니에서 복사해 쓴다면 지금은 생략해도 되지만, 이후 OC2를 업데이트할 때는 필요합니다.

```bash
S=~/apps/ocm-v2-staging
mkdir -p $S/toolchains/bun-1.4.4 && cd $S/toolchains/bun-1.4.4
curl -fLO https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip
curl -fLO https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt
grep ' bun-darwin-aarch64.zip$' SHASUMS256.txt | shasum -a 256 -c -
unzip -q bun-darwin-aarch64.zip
./bun-darwin-aarch64/bun --version   # 1.4.4
```

---

## 3. 디렉터리와 리포지토리 (범위 1)

### 3.1 기본 디렉터리

```bash
S=/Users/yeonghokim/apps/ocm-v2-staging
W=$S/data/workspace
mkdir -p $S/{bin,env,home,run,tmp,data/db,data/xdg/cache} $W/repos
chmod 700 $S $S/env $S/home $S/data
```

### 3.2 OCM 포크 (Manager)

```bash
git clone https://github.com/wineoflove/yeongho_opencode_manger_for_oc2.git $S/port
cd $S/port
git remote add upstream https://github.com/chriswritescode-dev/opencode-manager.git
git fetch upstream
git branch -vv            # main → origin/main

# 의존성: ocm-cli postinstall이 $HOME/.local/bin/ocm 링크를 바꾸므로 Manager 전용 HOME으로 설치
env HOME=$S/home PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  pnpm install --frozen-lockfile

# 빌드: 제공 위치는 backend/dist, frontend/dist
(cd backend && bun build src/index.ts --outdir=dist --target=bun)
(cd frontend && pnpm exec vite build)
ls backend/dist/index.js frontend/dist/index.html
```

### 3.3 OC2 커스텀 (native)

소스 저장소를 연결합니다. 이후 업데이트에 필요하고, Manager에서 `OC2 custom` 리포지토리로 등록합니다.

```bash
git clone --filter=blob:none https://github.com/wineoflove/yeongho_opencode2.git $W/repos/oc2-custom
cd $W/repos/oc2-custom
git remote add upstream https://github.com/anomalyco/opencode.git
git config remote.upstream.tagopt --no-tags
git log --oneline -3      # 8a138733 merge: OC2 custom 2.4.1-ocm-pool.36 into main
```

`main` 이력은 `.35`(첫 번째 부모)와 `upstream v2.4.1 + 포크 패치`(두 번째 부모, `820a2aaa feat(ocm-pool): OC2 custom 2.4.1-ocm-pool.36`)로 이루어져 있습니다. 트리는 upstream `v2.4.1`에 포크 95개 파일을 적용한 결과와 같으며, 맥미니 빌드 매니페스트의 파일 해시와 모두 일치합니다.

바이너리는 다음 둘 중 하나로 준비합니다.

**A. 맥미니 바이너리 복사 (권장, 빠름)**

```bash
install -d -m 700 $S/opencode/2.4.1-ocm-pool.36
cp ~/oc2-bundle/opencode $S/opencode/2.4.1-ocm-pool.36/opencode
chmod 755 $S/opencode/2.4.1-ocm-pool.36/opencode
shasum -a 256 $S/opencode/2.4.1-ocm-pool.36/opencode   # 70d79d6b…4c20 이어야 함
xattr -d com.apple.quarantine $S/opencode/2.4.1-ocm-pool.36/opencode 2>/dev/null || true
env -i HOME=$S/home PATH=/usr/bin:/bin $S/opencode/2.4.1-ocm-pool.36/opencode --version   # 2.4.1-ocm-pool.36
```

**B. 소스에서 빌드**

```bash
BUNDIR=$S/toolchains/bun-1.4.4/bun-darwin-aarch64
SRC=$S/run/oc2-src-36
OUT=$S/run/oc2-artifact-36            # 반드시 새 경로. 빌드 스크립트가 outdir을 지우고 시작합니다.
git -C $W/repos/oc2-custom worktree add --detach $SRC origin/main
mkdir -p $S/run/oc2-build-home/{.config,.local/share,.local/state,.cache,tmp}
BENV=(env -i HOME=$S/run/oc2-build-home PATH=$BUNDIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
      XDG_CONFIG_HOME=$S/run/oc2-build-home/.config XDG_DATA_HOME=$S/run/oc2-build-home/.local/share
      XDG_STATE_HOME=$S/run/oc2-build-home/.local/state XDG_CACHE_HOME=$S/run/oc2-build-home/.cache
      TMPDIR=$S/run/oc2-build-home/tmp)
cd $SRC
"${BENV[@]}" $BUNDIR/bun --no-env-file install --frozen-lockfile --ignore-scripts
"${BENV[@]}" OPENCODE_CHANNEL=ocm-pool OPENCODE_VERSION=2.4.1-ocm-pool.36 CI=true \
  $BUNDIR/bun --no-env-file run packages/cli/script/build.ts --single --skip-install --skip-web-ui --outdir=$OUT
install -d -m 700 $S/opencode/2.4.1-ocm-pool.36
cp $OUT/cli-darwin-arm64/bin/opencode $S/opencode/2.4.1-ocm-pool.36/opencode
$S/opencode/2.4.1-ocm-pool.36/opencode --version
git -C $W/repos/oc2-custom worktree remove $SRC
```

B 방식으로 빌드한 바이너리는 해시가 A와 비트 단위로 같지 않을 수 있습니다. 버전 문자열과 이후의 동작 확인으로 검증합니다.

### 3.4 워크스페이스 설정·스킬·학습 저장소 복원

`ocm-workspace-config`는 git dir를 작업 트리 **밖**에 둡니다. `data/workspace` 안에 `.git`을 만들면 OpenCode의 프로젝트 식별이 바뀌어 세션 생성이 깨지므로, `git init`이나 `git clone`을 워크스페이스에 직접 실행하지 않습니다.

```bash
G=/Users/yeonghokim/apps/ocm-workspace-config.git
git clone --no-checkout -b macmini https://github.com/wineoflove/ocm-workspace-config.git $S/run/wc-tmp
mv $S/run/wc-tmp/.git $G && rmdir $S/run/wc-tmp
git --git-dir=$G config core.worktree $W
# 새 Mac 전용 백업 브랜치 (맥미니의 macmini, Linux의 main과 섞이지 않게)
git --git-dir=$G --work-tree=$W checkout -b macbook
git --git-dir=$G --work-tree=$W checkout HEAD -- .
git --git-dir=$G --work-tree=$W status --short | head
```

`macbook`은 예시 이름입니다. 다른 이름을 쓰면 이후 단계에서도 같은 이름으로 바꿔 주세요.

맥미니에서는 지웠지만 백업 브랜치에는 아직 남아 있는 OC1 시절 파일을 정리합니다. 특히 `.config/opencode/opencode.json`은 OC1 형식이라 반드시 지웁니다.

```bash
cd $W
rm -rf .config/opencode/skills-archive .config/opencode/skills/opencode-account-recovery
rm -f .config/opencode/opencode.json .config/opencode/tui.json \
      .config/opencode/agents/goal-runner.md .config/opencode/anthropic-pool-admin.mjs \
      repos/assistant/.opencode/tests/goal-runner-session-scope.test.mjs
```

맥미니 묶음을 덮어 놓습니다. 최신 학습 기록, `opencode.jsonc`, 운영 스크립트, MCP 스크립트, launchd plist가 들어 있습니다.

```bash
tar -C / -xzpf ~/oc2-bundle/files.tgz
ls $W/.config/opencode/skills | wc -l      # 38
ls $W/.config/opencode/agents | wc -l      # 19 (sisyphus, prometheus, hephaestus, oracle, … junior-*)
ls $W/repos/assistant/.opencode/agents     # assistant.md
```

`opencode.jsonc`의 CLIProxy 키 경로만 새 Mac 패키지 위치로 바꿉니다. 맥미니는 `run/cliproxy-service-Dm5d7d/package`를 쓰고, 새 Mac은 `cliproxy/package`를 씁니다.

```bash
sed -i '' "s#$S/run/cliproxy-service-Dm5d7d/package#$S/cliproxy/package#g" $W/.config/opencode/opencode.jsonc
chmod 600 $W/.config/opencode/opencode.jsonc
grep -n 'apiKey\|baseURL' $W/.config/opencode/opencode.jsonc
```

`grep` 결과는 다음과 같아야 합니다.

```jsonc
// providers.openai.settings
"baseURL": "http://127.0.0.1:18788/v1",                       // Headroom → CLIProxy
"apiKey": "{file:/Users/yeonghokim/apps/ocm-v2-staging/cliproxy/package/keys/upstream.key}"
// providers.anthropic.settings
"baseURL": "http://127.0.0.1:5106/api/claude-inference/v1",   // Manager 게이트 → Headroom → CLIProxy
"apiKey": "{file:/Users/yeonghokim/apps/ocm-v2-staging/cliproxy/package/keys/ingress.key}"
```

전역 모델은 `openai/gpt-6.1-sol`입니다. MCP 8개(`ref`, `context7`, `markitdown`, `playwright`, `firecrawl`, `codegraph`, `claude-design`, `websearch`)와 TypeScript LSP도 같은 파일에 정의되어 있습니다. 키 값은 파일에 직접 쓰지 않고 `{file:…}`로만 참조합니다.

`plugins/ocm-*.js`와 `service-ocm-pool.json`은 Manager가 기동할 때 생성하므로 복사하지 않습니다. `comment-checker.js`는 백업 저장소에서 복원됩니다.

---

## 4. CLIProxy (범위 2)

### 4.1 바이너리 받기·검증

```bash
mkdir -p $S/downloads/cliproxy && cd $S/downloads/cliproxy
curl -fLO https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.3/CLIProxyAPI_8.1.3_darwin_aarch64.tar.gz
shasum -a 256 CLIProxyAPI_8.1.3_darwin_aarch64.tar.gz   # c6eee7e6…726f
tar xzf CLIProxyAPI_8.1.3_darwin_aarch64.tar.gz cli-proxy-api
shasum -a 256 cli-proxy-api                              # b578f4c1…7f68
xattr -d com.apple.quarantine cli-proxy-api 2>/dev/null || true
```

### 4.2 실행 패키지 생성

OCM 포크의 `prepareClaudeProxyPackage`를 사용합니다. 이 함수가 디렉터리, 무작위 키 3개(`ingress`/`upstream`/`management`), 게이트, `config.yaml`, launchd plist를 만듭니다. 맥미니도 같은 함수로 만들었습니다.

```bash
mkdir -p $S/cliproxy
cd $S/port
DEST=$S/cliproxy/package BIN=$S/downloads/cliproxy/cli-proxy-api \
SHA=b578f4c19b23cd94f95ff9ccb78dd1f1f2944b87d1737a90a6c09a18685d7f68 \
bun -e '
import { prepareClaudeProxyPackage } from "./backend/src/services/claude-proxy-package.ts";
console.log(await prepareClaudeProxyPackage({
  destination: process.env.DEST, binary: process.env.BIN,
  binarySha256: process.env.SHA, port: 5117 }));'
ls -la $S/cliproxy/package $S/cliproxy/package/keys
```

맥미니의 현재 설정에 맞춰 사용량 통계를 켭니다. Manager의 계정별 사용량 표시에 쓰입니다.

```bash
python3 - <<'EOF'
import json
p = "/Users/yeonghokim/apps/ocm-v2-staging/cliproxy/package/config.yaml"
c = json.load(open(p))
c["observability"]["usage"] = {"usage-statistics-enabled": True, "redis-usage-queue-retention-seconds": 300}
json.dump(c, open(p, "w"), indent=2)
EOF
```

나머지 설정은 맥미니와 같습니다. `0.0.0.0:5117`에서 대기하고, `management.allow-remote: false`와 `disable-control-panel: true`로 원격 관리를 막습니다. 라우팅은 `round-robin`, `session-affinity: false`, `request-retry: 0`, `max-retry-credentials: 1`이고 Claude `server-side-fallback`은 꺼져 있습니다.

### 4.3 launchd 등록·확인

```bash
cp $S/cliproxy/package/com.aion.ocm.claude-proxy.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aion.ocm.claude-proxy.plist
launchctl kickstart gui/$(id -u)/com.aion.ocm.claude-proxy
lsof -nP -iTCP:5117 -sTCP:LISTEN
curl -s -D - -o /dev/null -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/management.key)" \
  http://127.0.0.1:5117/v8/management/credentials | grep -i '^x-cpa-version'   # 8.1.3
```

계정은 Manager를 띄운 다음 UI에서 추가합니다([7.3](#73-cliproxy-계정-로그인)).

---

## 5. Headroom (범위 2)

```bash
H=$W/.opencode/tooling/headroom
uv venv --python 3.12 $H/.venv
uv pip install --python $H/.venv/bin/python -r ~/oc2-bundle/headroom-requirements.txt
$H/.venv/bin/python -m headroom.cli --version     # 0.45.0

# 선택: 맥미니 모델 캐시를 복사하면 첫 기동 때 모델을 다시 받지 않습니다
tar -C "$HOME" -xzf ~/oc2-bundle/huggingface.tgz

# 묶음에서 풀린 plist의 Python 경로와 onnxruntime 경로를 새 venv로 맞춥니다
P=~/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist
plutil -replace ProgramArguments.0 -string "$H/.venv/bin/python" $P
plutil -replace EnvironmentVariables.ORT_DYLIB_PATH -string \
  "$H/.venv/lib/python3.12/site-packages/onnxruntime/capi/libonnxruntime.1.31.0.dylib" $P
ls "$(plutil -extract EnvironmentVariables.ORT_DYLIB_PATH raw $P)"
mkdir -p $S/run/headroom/tmp
plutil -lint $P
launchctl bootstrap gui/$(id -u) $P
sleep 5; curl -s http://127.0.0.1:18788/health; echo
```

plist의 핵심 인자는 맥미니와 같습니다: `proxy --host 127.0.0.1 --port 18788 --stateless --no-telemetry --no-subscription-tracking --retry-max-attempts 1 --connect-timeout-seconds 3 --lossless`. `ANTHROPIC_TARGET_API_URL`와 `OPENAI_TARGET_API_URL`은 모두 `http://127.0.0.1:5117`(CLIProxy)입니다.

---

## 6. MCP와 로컬 도구 (범위 4)

### 6.1 공용 MCP 서버 (context7·firecrawl·markitdown·exa)

```bash
T=$W/.opencode/tooling
npm install --prefix $T/npm-mcp/context7  --save-exact @upstash/context7-mcp@4.7.3
npm install --prefix $T/npm-mcp/firecrawl --save-exact firecrawl-mcp@3.41.0
npm install --prefix $T/npm-mcp/playwright --save-exact @playwright/mcp@0.0.85
uv venv --python 3.10 $T/markitdown/.venv
uv pip install --python $T/markitdown/.venv/bin/python markitdown-mcp==0.0.1a8 markitdown==0.1.9

# 비밀값: Exa 키, Firecrawl 키(mcporter.json)
tar -C / -xzpf ~/oc2-bundle/secrets.tgz
chmod 700 ~/.local/share/opencode-manager/secrets ~/.local/share/ocm-migration-20260930/private
chmod 600 ~/.local/share/opencode-manager/secrets/exa-api-key ~/.local/share/ocm-migration-20260930/private/mcporter.json
```

Firecrawl 키만 따로 옮겼다면 `firecrawl.sh`가 읽는 형식으로 파일을 만듭니다. 키는 화면에 출력하지 않습니다.

```bash
install -d -m 700 ~/.local/share/ocm-migration-20260930/private
read -rs FK && umask 077 && jq -n --arg k "$FK" '{mcpServers:{firecrawl:{env:{FIRECRAWL_API_KEY:$k}}}}' \
  > ~/.local/share/ocm-migration-20260930/private/mcporter.json; unset FK
```

launchd에 등록합니다.

```bash
mkdir -p ~/apps/mcp-shared/logs
python3 ~/apps/mcp-shared/bin/write-plists.py     # ~/Library/LaunchAgents/io.wineoflove.mcp.*.plist 생성
for n in context7 firecrawl markitdown exa; do
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.wineoflove.mcp.$n.plist
done
sleep 3; for p in 5121 5122 5123 5124; do lsof -nP -iTCP:$p -sTCP:LISTEN | tail -1; done
node ~/apps/mcp-shared/bin/smoke.mjs        # 도구 목록·동시 접속·Host 거부
node ~/apps/mcp-shared/bin/call-smoke.mjs   # 실제 도구 호출 (Exa·Firecrawl 크레딧을 소량 사용)
```

### 6.2 Playwright MCP (Chrome 확장 방식)

1. Chrome을 설치하고, 사용할 프로필에 **Playwright MCP Bridge** 확장을 설치합니다.
2. 확장에 표시되는 토큰을 저장합니다.

   ```bash
   install -d -m 700 ~/.local/share/opencode-manager/secrets
   read -rs PWT && umask 077 && printf '%s' "$PWT" > ~/.local/share/opencode-manager/secrets/playwright-extension-token; unset PWT
   chmod 600 ~/.local/share/opencode-manager/secrets/playwright-extension-token
   ```

3. `$W/.opencode/tooling/playwright-mcp` wrapper는 맥미니의 `Profile 3`를 가리킵니다. 새 Mac에서 확장을 설치한 프로필 이름이 다르면(`chrome://version`의 프로필 경로 마지막 부분) `--profile-dir-name` 값을 그 이름으로 바꿉니다. 연결되지 않을 때는 `--user-data-dir` 값도 함께 확인합니다.

### 6.3 codegraph

```bash
tar -C "$HOME" -xzf ~/oc2-bundle/codegraph.tgz      # ~/.omo/codegraph (node 번들 + lib, 인덱스 제외)
~/.omo/codegraph/node ~/.omo/codegraph/lib/dist/bin/codegraph.js --version   # 1.5.0
```

인덱스는 옮기지 않습니다. 필요한 프로젝트에서 직접 `codegraph init`을 실행하세요. 인덱싱은 영호 님이 결정하는 작업이며, 에이전트는 스스로 실행하지 않습니다.

### 6.4 claude-design

소스는 묶음으로 복원됩니다(`$T/claude-design-mcp`). Node 22 이상과 **Claude Code CLI 로그인**이 필요합니다. 일반 셸에서 `claude`를 설치하고 로그인해 두세요. MCP 명령은 `HOME=/Users/yeonghokim`으로 실행되므로 Manager의 HOME이 아니라 사용자 HOME의 로그인을 사용합니다. Claude Desktop 앱(`/Applications/Claude.app`)에 번들된 CLI도 자동으로 찾습니다.

### 6.5 ref, websearch

- `ref`: 원격 `https://ref.theseeker.io/mcp`이며 인증이 필요 없습니다.
- `websearch`: 6.1의 Exa 프록시(`:5124`)입니다.

### 6.6 LSP와 UI 자동화 도구 (선택)

```bash
# TypeScript LSP (워크스페이스 백업에 package.json·lock 포함)
(cd $T/lsp && pnpm install --frozen-lockfile)
ln -sf $T/lsp/node_modules/typescript-language-server/lib/cli.mjs ~/.local/bin/typescript-language-server

# UI 자동화 (ui-automation 스킬이 사용): agent-browser 0.43.0, agent-desktop 1.3.1, cua-driver
npm ci --prefix $T/ui-automation
for t in agent-browser agent-desktop cua-driver; do ln -sf $T/ui-automation/bin/$t ~/.local/bin/$t; done
```

`cua-driver`를 쓰려면 `/Applications/CuaDriver.app`(맥미니는 0.55.0)을 공식 배포본으로 설치하고, 시스템 설정에서 손쉬운 사용과 화면 기록 권한을 허용합니다.

---

## 7. Manager 기동 (범위 1·2 연결)

### 7.1 환경 파일

비밀값(관리자 비밀번호, `AUTH_SECRET`)은 입력만 받고 화면에 출력하지 않습니다. `<새맥IP>`는 새 Mac의 LAN IP로 바꿉니다.

```bash
read -r  "ADMIN_EMAIL?관리자 이메일: "
read -rs "ADMIN_PASSWORD?관리자 비밀번호: "; echo
IP=<새맥IP>
umask 077
cat > $S/env/staging.env <<EOF
NODE_ENV=production
LOG_LEVEL=info
HOST=0.0.0.0
PORT=5106
CORS_ORIGIN=http://$IP:5106
AUTH_TRUSTED_ORIGINS=http://$IP:5106,http://localhost:5106,http://127.0.0.1:5106
AUTH_SECURE_COOKIES=false
AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
OPENCODE_SERVER_PORT=5107
OPENCODE_HOST=127.0.0.1
PREVIEW_PORT=5108
DATABASE_PATH=$S/data/db/opencode-manager.db
WORKSPACE_PATH=$W
XDG_CACHE_HOME=$S/data/xdg/cache
TMPDIR=$S/tmp/
OPENCODE_DISABLE_AUTOUPDATE=1
OPENCODE_DISABLE_CLAUDE_CODE=1
OCM_LEARNINGS_ENTRIES_PATH=$W/.opencode/learnings/entries
OPENCODE_BIN=$S/opencode/2.4.1-ocm-pool.36/opencode
OPENCODE_SERVICE_CHANNEL=ocm-pool
OCM_CLAUDE_PROXY_URL=http://127.0.0.1:5117
OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE=$S/cliproxy/package/keys/management.key
OCM_CLAUDE_INFERENCE_KEY_FILE=$S/cliproxy/package/keys/ingress.key
OCM_CLAUDE_PROXY_API_KEY_FILE=$S/cliproxy/package/keys/upstream.key
OCM_CLAUDE_PROXY_GATE_DIRECTORY=$S/cliproxy/package/gate
OCM_CLAUDE_INFERENCE_UPSTREAM_URL=http://127.0.0.1:18788
OCM_MAINTENANCE_MARKER=$S/run/maintenance.closed
EOF
unset ADMIN_PASSWORD
chmod 600 $S/env/staging.env
```

- `OCM_MAINTENANCE_MARKER`: 이 파일이 **있으면** Manager가 새 작업 접수를 막습니다(외부 업그레이드용). 평소에는 파일을 만들지 않습니다.
- Cloudflare Tunnel로 외부 도메인을 쓸 때만 `AUTH_TRUSTED_ORIGINS`에 그 도메인을 추가합니다. 맥미니의 `opencode2.wineoflove.com`을 그대로 재사용하지 마세요.

### 7.2 백엔드 launchd 등록

`files.tgz`에서 `bin/launchd-backend.sh`와 `~/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist`가 이미 풀려 있습니다. plist는 `HOME=$S/home`, `ENVFILE=$S/env/staging.env`, `WorkingDirectory=$S/port`로 `bin/launchd-backend.sh`를 실행합니다. 이 스크립트는 5106·5107·5108 포트를 다른 프로세스가 쓰고 있으면 기동을 거부하고, `bun run backend/dist/index.js`를 실행합니다.

```bash
chmod 700 $S/bin/*.sh
plutil -lint ~/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist
$S/bin/restart.sh && $S/bin/status.sh
curl -s http://127.0.0.1:5106/api/health | jq '{status, database, opencode, opencodeVersion, opencodeVersionSupported}'
# opencodeVersion: "2.4.1-ocm-pool.36", opencodeVersionSupported: true
tail -50 $S/run/backend.log
```

### 7.3 CLIProxy 계정 로그인

1. 브라우저에서 `http://<새맥IP>:5106`에 접속해 관리자 계정으로 로그인합니다.
2. **설정 → Providers → 프록시 계정**에서 Claude와 OpenAI 계정을 추가합니다. OAuth 페이지에서 로그인한 뒤 리디렉션 URL을 붙여 넣습니다.
3. 계정 수를 확인합니다.

   ```bash
   curl -s -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/management.key)" \
     http://127.0.0.1:5117/v8/management/credentials | jq '.files | length'
   ```

> **맥미니의 `auths/`를 복사하지 마세요.** 같은 refresh token을 두 프록시가 함께 쓰면 토큰이 회전될 때 한쪽이 로그아웃될 수 있습니다. 새 Mac에서 따로 로그인하는 방식이 안전합니다.

### 7.4 추론 경로 확인

Assistant에서 새 세션을 열고 `openai/gpt-6.1-sol`과 `anthropic/claude-opus-5-5`에 각각 짧은 메시지를 보내 응답이 오는지 확인합니다. 응답이 없으면 계층별로 나눠서 확인합니다.

```bash
# Headroom → CLIProxy (OpenAI 경로)
curl -s http://127.0.0.1:18788/v1/models -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/upstream.key)" | jq -r '.data[].id' | head
# 로그
tail -30 $S/run/headroom/headroom.log; tail -30 $S/cliproxy/package/logs/stderr.log; tail -30 $S/run/backend.log
```

### 7.5 GitHub 인증

에이전트 세션의 `gh`·`git push`는 Manager의 Git 자격증명에서 `GH_TOKEN`을 받습니다(`ocm-gh-env` 플러그인). **설정 → Git 자격증명**에 GitHub 토큰을 등록합니다(권한: `repo`, `workflow`, `read:org`).

---

## 8. 리포지토리 등록과 스킬 확인 (범위 1·4)

### 8.1 Manager에 리포지토리 등록

이후 업데이트 작업을 Manager 세션에서 하려면 두 소스 체크아웃을 로컬 리포지토리로 등록합니다. UI의 **리포지토리 추가 → 로컬 폴더**를 쓰거나, Assistant에게 다음과 같이 요청합니다.

> `ocm` request로 `POST /repos`에 `{ "localPath": "/Users/yeonghokim/apps/ocm-v2-staging/port" }`와 `{ "localPath": "/Users/yeonghokim/apps/ocm-v2-staging/data/workspace/repos/oc2-custom" }`를 등록하고, 이름을 각각 "OCM for OC2", "OC2 custom"으로 바꿔 줘.

`assistant`(repo 0)는 Manager가 자동으로 만듭니다. 다른 프로젝트(릴톡 마케팅, 통합 예약 시스템 등)는 필요할 때 UI에서 Git URL로 clone합니다.

### 8.2 스킬·에이전트·MCP 확인

Assistant 세션에서 다음을 확인합니다.

- 스킬 목록에 전역 38개가 보이는지 확인합니다: `ast-grep`, `better-*` 7종, `cloudflare-tunnel-routing`, `comment-checker`, `deep-research`, `dependency-auditor`, `docx`, `gh-issues`, `github`, `hallmark-marketing`, `impeccable-review`, `indirect-prompt-injection`, `lsp`, `mcp-builder`, `mcp-dependency-review`, `mcporter`, `pdf`, `pptx`, `receiving-code-review`, `self-improvement`, `senior-architect`, `setup-writing-style`, `skill-creator`, `skill-security-auditor`, `skill-validation`, `tmux`, `typescript`, `ui-automation`, `ultrawork`, `webapp-testing`, `xlsx`.
- Manager 생성 스킬 5개(`repo-management`, `schedule-management`, `notifications`, `manager-settings`, `session-management`)가 보이는지 확인합니다.
- subagent 목록에 `explorer`, `librarian`, `oracle`, `metis`, `momus`, `reviewer`, `looker`, `junior-*`가 있는지 확인합니다.
- MCP 8개가 모두 connected인지 확인합니다. 설정 화면이나 세션의 도구 목록에서 볼 수 있습니다.
- `ocm` 도구의 `learning_search`로 학습 저장소가 검색되는지 확인합니다. `sourceRoot`가 `$W/.opencode/learnings/entries`여야 합니다.

---

## 9. 학습·점검 스케줄 (범위 3)

Manager DB는 새로 만들어졌으므로 **스케줄 ID와 보고 세션 ID가 맥미니와 다릅니다.** 스케줄 프롬프트, `schedule-reports.json`, `review-config.json`이 이 ID들을 참조하기 때문에 모두 새 값으로 바꿔야 합니다.

### 9.1 보고 세션 만들기

Assistant 디렉터리(`$W/repos/assistant`)에 보고용 세션을 만들고 ID를 기록합니다. UI에서 새 세션을 만들어도 되고, Assistant에게 `ocm` request `POST /sessions`로 만들어 달라고 해도 됩니다.

| 용도 | 예시 제목 | 들어갈 곳 |
| --- | --- | --- |
| 학습 일일·주간 리뷰 보고 | `학습 리뷰 보고` | `review-config.json`의 `feedbackSession`, `schedule-reports.json`의 학습 작업 2개 |
| 핵심 6종 일일 버전 점검 | `일일 버전 점검 보고` | `schedule-reports.json` |
| 주간 버전 점검 | `주간 버전 점검 보고` | `schedule-reports.json` |
| 설정 백업 (선택) | `설정 백업 보고` | `schedule-reports.json` |

### 9.2 스케줄 등록

Assistant 세션에 다음 요청을 그대로 보냅니다.

> `~/oc2-bundle/schedules.json`에 있는 스케줄을 repo 0(Assistant)에 등록해 줘. `schedule-management` 스킬을 쓰고 각 항목의 `name`, `description`, `enabled`, `scheduleMode`, `cronExpression`, `timezone`, `agentSlug`, `model`, `workspaceMode`, `permissionConfig`(JSON 문자열을 객체로 파싱), `prompt`를 그대로 사용해. 학습 일일·주간 리뷰는 필수이고, 버전 점검 2개도 등록해. `workspace-config-backup`은 9.4를 적용한 뒤 등록해. 등록 후 맥미니 ID → 새 ID 대응표를 만들고, 각 프롬프트의 `--job <맥미니 ID>`와 `schedule-reports/job-<맥미니 ID>`를 새 ID로 PATCH해 줘. 새로 만든 보고 세션 ID로 `repos/assistant/.opencode/schedule-reports.json`의 `jobs`를 새 ID 기준으로 다시 쓰고, `.opencode/learnings/review-config.json`의 `feedbackSession`과 `cleanupJobIds`(학습 일일·주간의 새 ID)도 바꿔 줘. 마지막으로 등록된 스케줄을 `GET /repos/0/schedules`로 다시 읽어 대조해 줘.

등록이 끝나면 학습 일일 리뷰를 한 번 수동으로 실행해(`POST /repos/0/schedules/<새 ID>/run`) 다음을 확인합니다.

- 실행이 `completed`로 끝나는지
- 최종 응답에 `report_outcome`이 한 번 호출됐는지
- 학습 리뷰 보고 세션에 보고서가 게시됐는지

첫 실행은 새 DB에 분석할 대화가 거의 없으므로 결과가 짧은 것이 정상입니다.

### 9.3 두 대를 함께 운영할 때

- 학습 저장소(`$W/.opencode/learnings`)와 `assistant.md`는 Mac마다 따로 갱신됩니다. 학습 리뷰가 양쪽에서 돌면 기록과 지침이 서로 달라질 수 있습니다. 한쪽만 기준으로 삼으려면 다른 쪽의 학습 스케줄을 끄거나, 가끔 `macmini` 브랜치를 새 Mac 브랜치로 병합하세요. 이 병합은 사람이 직접 판단합니다.
- 설정 백업은 Mac마다 **다른 브랜치**에 push합니다. 맥미니는 `macmini`, 새 Mac은 `macbook`을 쓰며, `main`은 기존 Linux 서버용이라 건드리지 않습니다.

### 9.4 (선택) 설정 백업 스케줄

`workspace-config-backup` 프롬프트는 `macmini` 브랜치를 쓰도록 되어 있습니다. 등록하기 전에 프롬프트에서 다음을 바꿉니다.

- `macmini 브랜치` → `macbook 브랜치`, `refs/heads/macmini` → `refs/heads/macbook`, `push -u origin macmini` → `push -u origin macbook`
- `맥미니의 워크스페이스 설정` → `새 Mac의 워크스페이스 설정`

`--git-dir=/Users/yeonghokim/apps/ocm-workspace-config.git --work-tree=…` 경로는 그대로 사용합니다.

---

## 10. 최종 점검

```bash
$S/bin/status.sh
for p in 5106 5107 5108 5117 18788 5121 5122 5123 5124; do printf '%s ' $p; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo LISTEN || echo '-'; done
launchctl list | grep -E 'ocm2|claude-proxy|mcp\.'
curl -s http://127.0.0.1:5106/api/health | jq -r '.opencodeVersion'
curl -s http://127.0.0.1:18788/health; echo
git -C $S/port remote -v; git -C $W/repos/oc2-custom remote -v
git --git-dir=/Users/yeonghokim/apps/ocm-workspace-config.git branch --show-current
```

- [ ] Manager `/api/health`가 `healthy`이고 `opencodeVersion`이 `2.4.1-ocm-pool.36`이다
- [ ] 5106, 5107, 5108, 5117, 18788, 5121~5124 포트가 모두 대기 중이다
- [ ] 프록시 계정이 등록되어 있고, OpenAI·Anthropic 모델이 모두 응답한다
- [ ] MCP 8개가 connected이고 스킬 43개(전역 38 + Manager 생성 5)가 보인다
- [ ] `port`(origin·upstream), `oc2-custom`(origin·upstream), 워크스페이스 설정(`macbook` 브랜치)이 연결되어 있다
- [ ] 학습 일일·주간 스케줄이 등록되어 있고, 한 번 수동 실행해 보고서 게시까지 확인했다
- [ ] `~/oc2-bundle/secrets.tgz`를 양쪽 Mac에서 삭제했다

재부팅 후에도 launchd 서비스가 자동으로 뜨는지 한 번 확인하는 것을 권장합니다.

---

## 11. 업데이트 절차

일일·주간 버전 점검 스케줄이 새 버전 유무를 알려 줍니다. 실제 업데이트는 영호 님이 승인한 뒤 진행합니다. 실행 중인 세션을 끊지 않도록 **활성 세션이 0일 때** 진행하고, 백업과 롤백 경로를 먼저 확보합니다. Assistant에게 "OC2/CLIProxy 업데이트 해 줘"라고 요청하면 같은 단순 절차(사전 확인 → idle 대기 → 정지 → 백업 → 교체 → 기동 → 검증 → 실패 시 복구)를 외부 1회성 launchd 작업으로 진행합니다.

### 11.1 OCM (Manager)

```bash
cd $S/port
git status --short                       # 비어 있어야 함
git fetch origin && git merge --ff-only origin/main
env HOME=$S/home pnpm install --frozen-lockfile
$S/bin/build-oc2.sh                      # 운영 dist를 건드리지 않고 run/build-<시각>에 빌드
$S/bin/deploy-oc2-code.sh                # 활성 세션 0 확인 → dist 백업·교체 → 재시작 → 30초 안정화, 실패 시 롤백
```

upstream 변경을 포크에 반영할 때는 `git fetch upstream` 후 별도 브랜치에서 병합하고, 테스트(`pnpm test`, `pnpm typecheck`)를 거친 다음 `origin/main`에 push합니다.

### 11.2 OC2 native

1. 새 upstream 태그를 받습니다: `git -C $W/repos/oc2-custom fetch --no-tags upstream refs/tags/vX.Y.Z:refs/tags/vX.Y.Z`
2. 현재 포크 변경을 추출합니다: `git -C $W/repos/oc2-custom diff v2.4.1 origin/main > $S/run/fork.patch`. 현재 `main` 트리는 `v2.4.1` + 포크 패치입니다.
3. `vX.Y.Z`에서 worktree를 만들고 `git apply -3 $S/run/fork.patch`로 적용한 뒤 충돌을 해결합니다. 포크 관련 테스트(`packages/core/test/account-pool*`, `credential*`, `config/*` 등)와 `bun run check`를 실행합니다.
4. 커밋 `feat(ocm-pool): OC2 custom X.Y.Z-ocm-pool.<N+1>`을 만들고, 기존 `main`을 첫 부모로 하는 merge 커밋을 만들어 push합니다. 이렇게 하면 force push가 필요 없습니다.

   ```bash
   git commit-tree <패치 커밋>^{tree} -p origin/main -p <패치 커밋> -m "merge: OC2 custom X.Y.Z-ocm-pool.<N+1> into main"
   git push origin <merge SHA>:refs/heads/main
   ```

5. [3.3 B](#33-oc2-커스텀-native)와 같은 방식으로 빌드합니다. `OPENCODE_VERSION`과 Bun 버전은 새 `packageManager`에 맞춥니다. 결과물은 `$S/opencode/X.Y.Z-ocm-pool.<N+1>/opencode`에 둡니다.
6. 전환은 외부 1회성 작업으로 진행합니다:
   - idle 대기
   - 백엔드 정지와 5106·5107 해제 확인
   - native DB(`$W/.opencode/state/opencode/opencode-ocm-pool.db`와 `-wal`/`-shm`), Manager DB, `staging.env`를 SHA-256 검증과 함께 백업
   - `OPENCODE_BIN` 교체
   - 기동 후 `/api/health`의 `opencodeVersion` 확인
   - 실패 시 env와 DB를 복구하고 이전 버전으로 재기동

   새 버전에 native DB migration이 있으면 먼저 DB 사본에서 검증합니다.

### 11.3 CLIProxy

```bash
V=8.x.y
cd $S/downloads/cliproxy
curl -fLO https://github.com/router-for-me/CLIProxyAPI/releases/download/v$V/CLIProxyAPI_${V}_darwin_aarch64.tar.gz
# 릴리스 페이지의 checksum과 대조 → tar xzf … cli-proxy-api → xattr 정리
launchctl bootout gui/$(id -u)/com.aion.ocm.claude-proxy
cp -p $S/cliproxy/package/bin/cli-proxy-api $S/run/cli-proxy-api.before-$V
cp cli-proxy-api $S/cliproxy/package/bin/cli-proxy-api && chmod 700 $S/cliproxy/package/bin/cli-proxy-api
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aion.ocm.claude-proxy.plist
launchctl kickstart gui/$(id -u)/com.aion.ocm.claude-proxy
# x-cpa-version 헤더와 계정 수(.files | length)가 이전과 같은지 확인. 다르면 백업 바이너리로 되돌립니다.
```

### 11.4 Headroom

운영 venv를 직접 업그레이드하지 않습니다. 새 venv를 별도 경로에 만들고 검증한 뒤 plist의 `ProgramArguments.0`과 `ORT_DYLIB_PATH`만 바꿉니다.

```bash
NEW=$S/run/headroom-<버전>/.venv
uv venv --python 3.12 $NEW
uv pip install --python $NEW/bin/python 'headroom-ai[proxy]==<버전>'
$NEW/bin/python -m headroom.cli proxy --help >/dev/null
```

plist를 바꾼 뒤 `launchctl bootout`/`bootstrap`으로 재기동하고 `/health`의 버전을 확인합니다.

### 11.5 워크스페이스 설정·스킬

- 새 Mac 변경을 백업합니다. 9.4 스케줄이 하거나 수동으로 합니다: `git --git-dir=$G --work-tree=$W add <파일>` → `commit` → `push origin macbook`. `add .`, `add -A`, `add -u`는 쓰지 않습니다.
- 맥미니 변경을 가져옵니다: `git --git-dir=$G fetch origin` 후 `git --git-dir=$G --work-tree=$W diff macbook origin/macmini -- .config/opencode repos/assistant`로 확인하고, 필요한 파일만 `checkout origin/macmini -- <경로>`로 가져옵니다.
- MCP 패키지는 `npm install --prefix $T/npm-mcp/<이름> --save-exact <패키지>@<버전>` 후 `launchctl kickstart -k gui/$(id -u)/io.wineoflove.mcp.<이름>`으로 갱신합니다.

---

## 12. 다른 사용자명일 때

`/Users/yeonghokim`이 들어 있는 곳을 모두 새 HOME으로 바꿔야 합니다. 대상은 다음과 같습니다.

- `$S/bin/*`
- `~/apps/mcp-shared/bin/*`
- `$W/.config/opencode/{opencode.jsonc,AGENTS.md,agents/*,skills/*/SKILL.md,instructions/*}`
- `$W/repos/assistant/{AGENTS.md,opencode.json,.opencode/agents/assistant.md,.opencode/docs/*,.opencode/bin/*,.opencode/schedule-reports.json}`
- `$W/.opencode/learnings/{review-config.json,application-config.json}`
- `$T/playwright-mcp`, `$T/ui-automation/bin/*`
- `~/Library/LaunchAgents/*.plist`
- `~/oc2-bundle/schedules.json`의 프롬프트

```bash
OLD=/Users/yeonghokim; NEW=$HOME
grep -rlI "$OLD" $S/bin ~/apps/mcp-shared/bin $W/.config/opencode $W/repos/assistant \
  $W/.opencode/learnings/review-config.json $W/.opencode/learnings/application-config.json \
  $T/playwright-mcp $T/ui-automation/bin ~/Library/LaunchAgents ~/oc2-bundle/schedules.json 2>/dev/null
# 목록을 확인한 다음 각 파일에 sed -i '' "s#$OLD#$NEW#g" <파일>
```

`.opencode/learnings/entries/`와 `reviews/`의 기록은 과거의 증거이므로 경로를 바꾸지 않습니다. 원래 경로가 남아 있어야 근거로서 의미가 있습니다.

---

## 13. 문제 해결

| 증상 | 확인할 곳 |
| --- | --- |
| 백엔드가 계속 재시작됨 | `$S/run/backend.log`. "port … held by pid"이면 다른 프로세스가 5106·5107·5108을 쓰고 있습니다. 그 프로세스를 직접 확인하고, 이름 패턴으로 일괄 종료하지 마세요 |
| `opencodeVersionSupported: false` 또는 5107이 대기하지 않음 | `OPENCODE_BIN` 경로·실행 권한·quarantine 속성, `opencode --version` |
| Anthropic 모델만 실패 | `OCM_CLAUDE_INFERENCE_*` 키 경로, Headroom 18788 상태, CLIProxy Claude 계정 |
| OpenAI 모델만 실패 | `opencode.jsonc`의 `upstream.key` 경로, Headroom → 5117, Codex 계정 |
| MCP가 disconnected | `~/apps/mcp-shared/logs/<이름>.log`, 키 파일 권한(600), `node ~/apps/mcp-shared/bin/smoke.mjs` |
| Playwright MCP 실패 | 토큰 파일 권한(0600, 심볼릭 링크 불가), Chrome 확장 설치 프로필과 `--profile-dir-name` |
| 스케줄이 `JOB_NOT_CONFIGURED` / `SELF_RUN_NOT_FOUND` | `schedule-reports.json`의 job ID·보고 세션 ID가 새 값인지 확인 |
| 학습 리뷰 게시 실패 | `review-config.json`의 `feedbackSession`이 존재하는 세션인지 확인 |
| 세션 생성이 FOREIGN KEY 오류로 실패 | `data/workspace` 안에 `.git`이 생겼는지 확인. 워크스페이스 설정 git dir은 반드시 밖(`~/apps/ocm-workspace-config.git`)에 둡니다 |

운영 규칙은 맥미니와 같습니다.

- 대화 세션 안에서 Manager·CLIProxy·Headroom·공용 MCP를 재시작하지 않습니다. 승인된 외부 1회성 작업으로만 재시작합니다.
- 5003·5551 포트는 쓰지 않습니다.
- 비밀값은 `{file:…}`이나 키 파일로만 참조하고 Git에 올리지 않습니다.
