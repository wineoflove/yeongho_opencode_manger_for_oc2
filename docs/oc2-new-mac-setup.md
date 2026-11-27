# OC2 새 Mac 설치 가이드

맥미니에서 운영 중인 OC2 환경을 다른 Mac(Apple Silicon)에 같은 구성으로 설치하는 절차입니다. 2026-11-26 맥미니 상태를 기준으로 작성했습니다.

설치 범위:

1. OC2 커스텀(native) + OCM(Manager) 포크. 이후 업데이트할 수 있도록 각 리포지토리를 `origin`·`upstream`으로 연결합니다.
2. CLIProxy + Headroom 연결
3. 학습 일일·주간 리뷰 스케줄. 버전 점검과 설정 백업 스케줄은 선택입니다.
4. 주요 MCP 서버와 스킬

옮기지 않는 것: 세션·대화 이력(native DB), Manager DB의 세션 기록, 맥미니의 GitHub 토큰·CLIProxy 로그인·API 키, OpenClaw, Cloudflare Tunnel(`opencode2.wineoflove.com`), 예약 시스템이나 건강 포털 같은 다른 서비스.

---

## 0. 구성 한눈에 보기

```text
브라우저 ─▶ OCM Manager :MANAGER  (launchd io.wineoflove.ocm2.backend, bun backend/dist/index.js)
             ├─ OC2 native :OPENCODE  (Manager가 OPENCODE_BIN을 자식 프로세스로 실행)
             │    ├─ openai/*    ─▶ Headroom :HEADROOM/v1 ─▶ CLIProxy :CLIPROXY ─▶ ChatGPT(Codex) 계정
             │    └─ anthropic/* ─▶ Manager :MANAGER/api/claude-inference/v1 ─▶ Headroom :HEADROOM ─▶ CLIProxy :CLIPROXY ─▶ Claude 계정
             └─ preview :PREVIEW

OC2 ─▶ MCP  context7 :CONTEXT7 · firecrawl :FIRECRAWL · markitdown :MARKITDOWN · exa :EXA   (launchd 공용 서버, ~/apps/mcp-shared)
            ref (원격 https://ref.theseeker.io/mcp)
            playwright · codegraph · claude-design   (OC2가 띄우는 로컬 프로세스)
```

포트는 이 Mac에 맞게 정합니다([1.1](#11-포트-정하기)). 맥미니 기본값은 Manager `5106`, OC2 `5107`, preview `5108`, CLIProxy `5117`, Headroom `18788`, MCP `5121`~`5124`입니다.

**설치 버전은 가이드에 적혀 있지 않습니다.** 맥미니가 지금 실제로 쓰는 버전이 [`deploy/new-mac/versions.env`](../deploy/new-mac/versions.env)에 기록되어 있고, 이 가이드의 명령은 모두 그 값을 읽어 설치합니다. 그래서 언제 받아 가도 그 시점 맥미니의 최신 버전으로 설치됩니다. 이 파일과 번들은 맥미니에서 `publish-baseline.sh`로 갱신합니다([12.6](#126-설치-기준-갱신-맥미니)).

| 구성 요소 | 버전을 정하는 곳 | 원본 |
| --- | --- | --- |
| OC2 native | `OC2_VERSION`, `OC2_SHA256` | `wineoflove/yeongho_opencode2` Release `v<OC2_VERSION>`(바이너리), `main`(소스), upstream `anomalyco/opencode` |
| OCM (Manager) | 포크 `main` 최신 커밋 | `wineoflove/yeongho_opencode_manger_for_oc2`, upstream `chriswritescode-dev/opencode-manager` |
| 맥미니 운영 파일 번들 | `deploy/new-mac/oc2-macmini-bundle.tgz`(`SHA256SUMS`로 검증) | 이 저장소 (비밀값 제외) |
| 워크스페이스 설정·스킬·학습 저장소 | 처음 설치 때 `macmini` 브랜치 → 이후 이 Mac 전용 `<기기명>-<계정명>` 브랜치 | `wineoflove/ocm-workspace-config` (비공개) |
| CLIProxyAPI | `CLIPROXY_VERSION`, `CLIPROXY_TGZ_SHA256`, `CLIPROXY_BIN_SHA256` | `router-for-me/CLIProxyAPI` GitHub Releases |
| Headroom | `HEADROOM_VERSION`(Python 3.12, 의존성은 번들의 `headroom-requirements.txt`) | PyPI |
| Bun / pnpm | `BUN_VERSION`, `PNPM_VERSION`(런타임). OC2 소스 빌드용 Bun은 `yeongho_opencode2`의 `packageManager` | npm `bun` / `oven-sh/bun` Releases |
| Node / uv | Homebrew 최신 | |
| MCP | npm lock·`markitdown-requirements.txt`(번들), `CODEGRAPH_VERSION`, claude-design(자체) | |
| 스킬 | 전역 38개 + Manager 생성 5개 | `ocm-workspace-config` |

각 파일의 SHA-256 검증 값도 `versions.env`와 `SHA256SUMS`에 들어 있어, 아래 명령이 자동으로 대조합니다.

---

## 1. 경로 규칙과 공통 변수

**사용자명은 달라도 됩니다.** 대신 HOME 아래의 배치는 맥미니와 같게 둡니다.

```text
$HOME/apps/ocm-v2-staging/          ($S)
  port/                             OCM 포크 체크아웃 (Manager 실행 위치)
  opencode/<OC2_VERSION>/           OC2 native 바이너리
  cliproxy/package/                 CLIProxy 실행 패키지 (bin, config.yaml, keys, auths, gate)
  env/staging.env                   Manager 환경변수 (권한 600, 비밀값 포함)
  bin/                              운영 스크립트 (launchd-backend.sh, restart.sh, build/deploy …)
  home/                             Manager 전용 HOME
  data/db/                          Manager DB
  data/workspace/                   WORKSPACE_PATH ($W)
    .config/opencode/               OC2 전역 설정·에이전트·스킬·플러그인
    .opencode/learnings/            전역 학습 저장소
    .opencode/tooling/              MCP·LSP·Headroom 등의 설치 위치 ($T)
    repos/assistant/                Assistant 워크스페이스
    repos/oc2-custom/               OC2 포크 소스 (업데이트용)
$HOME/apps/mcp-shared/              공용 MCP 서버 스크립트·로그
$HOME/apps/ocm-workspace-config.git 워크스페이스 설정 백업 저장소의 git dir (작업 트리 밖, $G)
$HOME/.codegraph/                   codegraph 실행 파일
```

맥미니에서 가져온 지침·스크립트·plist·스케줄 프롬프트에는 맥미니 HOME(`/Users/yeonghokim`)이 절대경로로 들어 있습니다. [4.5](#45-맥미니-번들-풀기와-경로-변환)의 `relocate.sh`가 이 값을 새 Mac의 HOME으로 한 번에 바꿉니다. 같은 사용자명이면 아무것도 바꾸지 않습니다.

아래 명령은 모두 **새 Mac의 일반 터미널(zsh)** 기준입니다. 새 터미널을 열면 먼저 이 변수를 다시 설정하세요.
- `CONFIG_BRANCH`는 이 Mac 전용 설정 브랜치 이름입니다([1.2](#12-설정-브랜치-이름)).
- 마지막 줄은 기준 버전 파일(바로 아래)과 [1.1](#11-포트-정하기)의 포트 파일을 불러옵니다. 아직 없는 파일은 건너뜁니다.

```bash
U=$HOME
S=$U/apps/ocm-v2-staging
W=$S/data/workspace
T=$W/.opencode/tooling
G=$U/apps/ocm-workspace-config.git
CONFIG_BRANCH=$(cat $S/env/config-branch 2>/dev/null || printf '%s-%s' "$(scutil --get LocalHostName)" "$(id -un)" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
set -a; for f in $S/env/versions.env $S/env/ports.env; do [ -f $f ] && . $f; done; set +a
```

처음 한 번, 맥미니의 현재 기준 버전 파일을 받아 둡니다. 저장소는 4.2에서 clone하므로 지금은 이 파일만 내려받습니다.

```bash
mkdir -p $S/env && chmod 700 $S/env
curl -fsSL https://raw.githubusercontent.com/wineoflove/yeongho_opencode_manger_for_oc2/main/deploy/new-mac/versions.env \
  -o $S/env/versions.env
set -a; . $S/env/versions.env; set +a
grep -v '^#' $S/env/versions.env
```

### 1.1 포트 정하기

포트는 Mac마다 상황이 다를 수 있으므로 **이 Mac에 맞게 정합니다.** 아래는 맥미니에서 쓰는 값이며, 다른 서비스와 겹치지 않으면 그대로 써도 됩니다.

| 변수 | 맥미니 값 | 용도 | 바깥에서 접속 |
| --- | --- | --- | --- |
| `MANAGER_PORT` | 5106 | OCM Manager 웹 UI·API, Claude 추론 게이트 | 예 (`0.0.0.0`, 브라우저 접속 주소) |
| `OPENCODE_PORT` | 5107 | OC2 native 서버 | 아니요 (`127.0.0.1`) |
| `PREVIEW_PORT` | 5108 | 터미널·미리보기 | 예 |
| `CLIPROXY_PORT` | 5117 | CLIProxy | 대기는 `0.0.0.0`, 관리 API는 로컬만 |
| `HEADROOM_PORT` | 18788 | Headroom 압축 프록시 | 아니요 |
| `CONTEXT7_PORT` | 5121 | Context7 MCP | 아니요 |
| `FIRECRAWL_PORT` | 5122 | Firecrawl MCP | 아니요 |
| `MARKITDOWN_PORT` | 5123 | MarkItDown MCP | 아니요 |
| `EXA_PORT` | 5124 | Exa(websearch) MCP | 아니요 |

규칙:
- 1024~65535 사이에서 9개가 모두 달라야 합니다.
- `5003`, `5551`은 Manager 코드의 기본 포트라 쓰지 않습니다.

먼저 맥미니 값으로 포트 파일을 만듭니다. 같은 내용의 기본 파일이 저장소의 `deploy/new-mac/ports.env`에도 있습니다.

```bash
mkdir -p $S/env && chmod 700 $S/env
[ -e $S/env/ports.env ] || cat > $S/env/ports.env <<'EOF'
MANAGER_PORT=5106
OPENCODE_PORT=5107
PREVIEW_PORT=5108
CLIPROXY_PORT=5117
HEADROOM_PORT=18788
CONTEXT7_PORT=5121
FIRECRAWL_PORT=5122
MARKITDOWN_PORT=5123
EXA_PORT=5124
EOF
```

각 포트를 이미 쓰는 프로세스가 있는지 서비스 이름과 함께 확인합니다. 저장소는 4.2에서 clone하므로, 지금은 스크립트를 내려받아 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/wineoflove/yeongho_opencode_manger_for_oc2/main/deploy/new-mac/check-ports.sh \
  -o $S/env/check-ports.sh
bash $S/env/check-ports.sh $S/env/ports.env
```

```text
SERVICE         VARIABLE         PORT   LISTENER
Manager         MANAGER_PORT     5106   free
…
Headroom        HEADROOM_PORT    18788  python3.1 (pid 812)      ← 이미 사용 중
```

`free`가 아닌 포트는 다른 값으로 바꾸고 다시 확인합니다. 예를 들어 Headroom 포트 18788을 다른 프로그램이 쓰고 있으면 18789로 바꿉니다.

```bash
sed -i '' 's/^HEADROOM_PORT=.*/HEADROOM_PORT=18789/' $S/env/ports.env
bash $S/env/check-ports.sh $S/env/ports.env
set -a; . $S/env/ports.env; set +a
```

- 다른 사용자나 root가 띄운 프로세스는 `sudo` 없이 이름이 보이지 않습니다. 그런 포트는 `in use by another user's process`로 표시되니 그 포트는 피합니다.
- 설치를 마친 뒤 다시 실행하면 OC2 자신의 서비스가 표시됩니다. 그때는 그 포트의 서비스가 맞는지만 봅니다.

포트 값이 반영되는 곳:
- 맥미니에서 가져온 파일(운영 스크립트, MCP 스크립트, `opencode.jsonc`, Headroom plist, 지침의 포트 목록)은 [4.6](#46-포트-적용)의 `set-ports.sh`가 이 파일 값으로 바꿉니다.
- `staging.env`와 CLIProxy 패키지는 이 가이드의 명령이 위 변수로 만듭니다.
- 이후 절의 명령도 모두 이 변수를 씁니다.

설치를 마친 뒤에 포트를 바꾸려면 [12.7](#127-설치-후-포트-바꾸기)을 따릅니다.

### 1.2 설정 브랜치 이름

워크스페이스 설정 저장소(`ocm-workspace-config`)는 기기마다 브랜치를 따로 씁니다. 이 Mac의 브랜치 이름은 **기기명-계정명**입니다.

- 기기명: 시스템 설정 → 일반 → 공유의 로컬 호스트 이름(`scutil --get LocalHostName`)
- 계정명: macOS 사용자명(`id -un`)
- 소문자로 바꾸고 영문·숫자 외의 문자는 `-`로 바꿉니다. 예: 로컬 호스트 이름 `Yeonghos-MacBook-Pro` + 계정 `yeongho` → `yeonghos-macbook-pro-yeongho`

```bash
echo "$CONFIG_BRANCH"      # 1절 공통 변수에서 계산된 이름
```

이름은 [4.4](#44-워크스페이스-설정스킬학습-저장소-복원)에서 `$S/env/config-branch`에 기록합니다. 그다음부터는 이 파일 값을 씁니다. 나중에 기기 이름을 바꿔도 브랜치 이름은 바뀌지 않습니다.

| 브랜치 | 용도 |
| --- | --- |
| `macmini` | 맥미니 백업. 새 Mac은 **처음 설치할 때 한 번만** 복사해 오고, 이후에는 변경 사항을 참고할 때만 읽습니다 |
| `main` | 기존 Linux 서버용. 건드리지 않습니다 |
| `<기기명>-<계정명>` | 이 Mac 전용. 설치 직후 첫 커밋을 올리고, 이후 백업도 이 브랜치에만 push합니다 |

### 1.3 표시와 중단 후 재개

가이드의 명령 블록 앞에는 다음 표시를 붙였습니다.

| 표시 | 뜻 | 할 일 |
| --- | --- | --- |
| **[확인]** | 파일을 지우거나 덮어쓰거나, launchd에 서비스를 등록하는 블록 | 바로 앞의 미리보기·대상 목록을 확인한 뒤 실행합니다. 에이전트에게 맡겼다면 이 블록 직전에 멈추고 확인을 받게 합니다 |
| **[직접]** | 토큰·키·비밀번호 입력이나 GUI 조작처럼 사람이 해야 하는 단계 | 안내된 명령이나 화면 조작을 직접 하고, 이어지는 **완료 확인**의 결과를 봅니다. 비밀값은 채팅에 붙여 넣지 않습니다 |

설치는 중간에 멈췄다가 이어서 해도 됩니다. 새 터미널에서 [1](#1-경로-규칙과-공통-변수)의 공통 변수를 다시 설정한 뒤, 아래 표의 완료 확인으로 어디까지 됐는지 보고 그다음 절부터 진행합니다. **[확인]** 블록은 다시 실행하기 전에 이미 적용됐는지부터 확인합니다.

| 절 | 완료 확인 | 완료 상태 |
| --- | --- | --- |
| 1 | `echo $OC2_VERSION $CLIPROXY_VERSION $HEADROOM_VERSION` | 버전 3개 출력 |
| 1.1 | `cat $S/env/ports.env` | 포트 9개 |
| 2 | `bun --version; pnpm --version; gh --version` | 버전 출력 |
| 3.2 | `gh api user --jq .login` | 이 Mac의 GitHub 계정 |
| 4.2 | `ls $S/port/backend/dist/index.js $S/port/frontend/dist/index.html` | 두 파일 있음 |
| 4.3 | `$S/opencode/$OC2_VERSION/opencode --version` | `v$OC2_VERSION` |
| 4.4 | `cat $S/env/config-branch; git --git-dir=$G branch --show-current` | 같은 이름 |
| 4.5 | `ls $S/run/new-mac-meta/manifest.json` | 파일 있음 |
| 4.6 | `cat $S/env/ports.applied.env` | `ports.env`와 같은 값 |
| 4.7 | `git --git-dir=$G status -sb \| head -1` | `## <브랜치>...origin/<브랜치>` |
| 5 | `launchctl print gui/$(id -u)/com.aion.ocm.claude-proxy \| grep -m1 'state ='` | `running` |
| 6 | `curl -s http://127.0.0.1:$HEADROOM_PORT/health` | `"status":"healthy"` |
| 7.1 | `bash $S/port/deploy/new-mac/check-ports.sh $S/env/ports.env` | MCP 포트 4개가 node·python |
| 8.1 | `test -s $S/env/staging.env && echo ok` | `ok` |
| 8.2 | `curl -s http://127.0.0.1:$MANAGER_PORT/api/health \| jq -r .status` | `healthy` |

---

## 2. 사전 준비

**[직접]** Xcode Command Line Tools는 설치 창이 뜨고, Homebrew는 macOS 비밀번호(sudo)를 묻습니다.

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

완료 확인: `xcode-select -p`가 경로를 출력하고, `/opt/homebrew/bin/brew --version`이 버전을 출력합니다.

```bash
brew install git gh jq node uv sqlite

# 런타임 bun / pnpm (맥미니와 같은 위치·버전, versions.env의 BUN_VERSION·PNPM_VERSION)
mkdir -p $U/.local/share/ocm-toolchain $U/.local/bin
npm install --prefix $U/.local/share/ocm-toolchain --save-exact "bun@$BUN_VERSION" "pnpm@$PNPM_VERSION"
ln -sf $U/.local/share/ocm-toolchain/node_modules/.bin/{bun,bunx,pnpm,pnpx} $U/.local/bin/
echo 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"' >> $U/.zprofile
exec zsh -l
bun --version; pnpm --version; node --version; uv --version
```

새 셸이 열렸으므로 [1](#1-경로-규칙과-공통-변수)의 공통 변수를 다시 설정합니다. `bun --version`과 `pnpm --version`이 `versions.env`의 값과 같아야 합니다.

OC2를 소스에서 빌드할 때 쓰는 Bun은 4.3 B에서 따로 받습니다.

---

## 3. GitHub 토큰 (새 Mac 전용)

맥미니 토큰을 복사하지 않고 **이 Mac만 쓰는 토큰을 새로 발급**합니다. 기기마다 토큰이 따로 있으면 한 대를 정리할 때 그 토큰만 폐기하면 됩니다. 토큰은 **Personal access token (classic)**으로 발급합니다.

### 3.0 GitHub 계정과 저장소 접근

이 Mac에서 쓰는 GitHub 계정이 `wineoflove`가 아닐 수 있습니다. 그런 경우 그 계정이 `wineoflove` 소유의 비공개 저장소에 **collaborator**로 초대되어 있어야 합니다.

| 저장소 | 공개 여부 | 필요한 권한 |
| --- | --- | --- |
| `wineoflove/ocm-workspace-config` | 비공개 | clone·push(전용 브랜치). **collaborator 필요** |
| `wineoflove/yeongho_opencode_manger_for_oc2` | 공개 | clone은 누구나 가능. push·번들 갱신은 collaborator 필요 |
| `wineoflove/yeongho_opencode2` | 공개 | clone·Release 다운로드는 누구나 가능. push·Release 생성은 collaborator 필요 |
| 이 Mac에서 작업할 다른 비공개 저장소 | 비공개 | collaborator 필요 |

**[직접]**
1. `wineoflove` 계정에서 각 저장소의 **Settings → Collaborators → Add people**로 이 Mac의 계정을 초대합니다. 개인 계정 소유 저장소의 collaborator는 항상 읽기·쓰기 권한을 받습니다.
2. 이 Mac의 계정에서 초대를 수락합니다(메일 또는 `https://github.com/notifications`).
3. 이 Mac에서도 `wineoflove` 계정을 그대로 쓴다면 이 절은 건너뜁니다.

완료 확인은 3.2에서 토큰을 등록한 뒤 `permissions.push`로 합니다.

### 3.1 발급

**[직접]** GitHub 웹에서 발급합니다. 이 Mac에서 쓰는 GitHub 계정으로 로그인해서 **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**을 선택합니다.

- 이름(Note): `oc2-<기기명>-<계정명>`. 설정 브랜치와 같은 이름을 쓰면 어느 기기 토큰인지 알기 쉽습니다.
- 만료일(Expiration): 기한을 정합니다. 예: 90일. 만료 전에 GitHub가 메일로 알려 줍니다.
- Scope: 아래 3개는 **반드시 포함**해야 합니다. 이 가이드의 기능은 이 3개만으로 모두 동작합니다.
  - `repo`: 비공개 저장소 clone·push, 이슈·PR
  - `workflow`: upstream 병합 때 `.github/workflows` 변경을 push하려면 필요
  - `read:org`: `gh auth login`의 최소 요구 scope
- 추가 scope는 **선택**입니다. 이 Mac에서 다른 작업도 한다면 더 넣어도 되고, 이미 더 많은 권한을 가진 토큰을 받았다면 그대로 써도 됩니다. 예: `gist`, `write:packages`(맥미니 토큰에 포함), `admin:org`, `delete_repo`

> **Fine-grained token을 쓰지 않는 이유**: GitHub 공식 문서의 fine-grained 토큰 제한 목록에 "outside collaborator 또는 repository collaborator인 저장소에는 기여할 수 없음"이 있습니다. 그래서 다른 계정 소유의 비공개 저장소(`ocm-workspace-config` 등)에 collaborator로 접근하려면 classic 토큰이 필요합니다. 출처: [Managing your personal access tokens — Fine-grained personal access tokens limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations)

Classic 토큰은 그 계정이 접근할 수 있는 **모든 저장소**에 같은 권한으로 접근합니다. 이 토큰은 Manager를 거쳐 에이전트 세션의 `GH_TOKEN`으로도 쓰입니다.
- 권장: 이 Mac 전용으로 새로 발급한다면 필수 3개만 두는 편이 안전합니다. 저장소 삭제(`delete_repo`)나 조직 관리(`admin:*`) 같은 강한 권한은 에이전트도 쓸 수 있게 됩니다.
- 만료일을 둡니다.
- 기기를 정리할 때 그 기기의 토큰을 바로 폐기합니다(Settings → Developer settings → Tokens (classic) → Delete).

토큰 값(`ghp_`로 시작)은 발급 화면에서만 볼 수 있습니다. 비밀번호 관리자에 보관하고, 채팅·문서·Git에는 붙여 넣지 않습니다.

### 3.2 터미널(gh·git)에 등록

**[직접]** 토큰은 입력만 받고 화면에 출력하지 않습니다. macOS 키체인에 저장됩니다.

```bash
read -rs "GHT?GitHub 토큰: "; echo
printf '%s' "$GHT" | gh auth login --hostname github.com --git-protocol https --with-token
unset GHT
gh auth setup-git        # git clone·push가 gh 인증을 사용
```

완료 확인:

```bash
gh api user --jq .login                                                   # 이 Mac에서 쓰는 GitHub 계정
gh api repos/wineoflove/ocm-workspace-config --jq .permissions.push      # true
gh auth status 2>&1 | grep -i scopes                                      # repo, workflow, read:org 포함(더 있어도 됨)
```

`permissions.push`가 `false`이거나 `Not Found`이면 3.0의 collaborator 초대·수락과 3.1의 scope를 확인합니다. 여기서 확인한 계정 이름은 8.5에서 Assistant의 결과와 비교합니다.

### 3.3 Manager에 등록

에이전트 세션의 `gh`·`git push`와 설정 백업 스케줄은 Manager에 등록된 자격 증명을 씁니다(`ocm-gh-env` 플러그인과 내부 `/git-credentials/gh-env`). Manager를 띄운 다음 [8.5](#85-manager에-github-토큰-등록)에서 **같은 classic 토큰**을 등록합니다.

---

## 4. 리포지토리와 맥미니 번들 (범위 1)

### 4.1 기본 디렉터리

```bash
mkdir -p $S/{bin,env,home,run,tmp,downloads,data/db,data/xdg/cache} $W/repos
chmod 700 $S $S/env $S/home $S/data
ls $S/env/ports.env      # 1.1에서 만든 포트 파일
```

### 4.2 OCM 포크 (Manager)

```bash
git clone https://github.com/wineoflove/yeongho_opencode_manger_for_oc2.git $S/port
cd $S/port
git remote add upstream https://github.com/chriswritescode-dev/opencode-manager.git
git fetch upstream
git branch -vv            # main → origin/main

# 의존성: ocm-cli postinstall이 $HOME/.local/bin/ocm 링크를 바꾸므로 Manager 전용 HOME으로 설치
env HOME=$S/home PATH="$U/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  pnpm install --frozen-lockfile

# 빌드: 제공 위치는 backend/dist, frontend/dist
(cd backend && bun build src/index.ts --outdir=dist --target=bun)
(cd frontend && pnpm exec vite build)
ls backend/dist/index.js frontend/dist/index.html
```

clone한 저장소의 기준 버전 파일로 1절에서 받은 파일을 맞춥니다. 그사이 맥미니 기준이 갱신됐다면 여기서 새 값으로 바뀝니다. 번들도 같은 커밋에 있으므로 이후에는 이 값을 씁니다.

```bash
cmp -s $S/port/deploy/new-mac/versions.env $S/env/versions.env || echo "기준 버전이 갱신되었습니다. 새 값을 씁니다."
cp $S/port/deploy/new-mac/versions.env $S/env/versions.env
set -a; . $S/env/versions.env; set +a
echo "OC2 $OC2_VERSION / CLIProxy $CLIPROXY_VERSION / Headroom $HEADROOM_VERSION"
```

### 4.3 OC2 커스텀 (native)

업데이트용 소스 저장소를 연결합니다. Manager에서 `OC2 custom` 리포지토리로 등록합니다.

```bash
git clone --filter=blob:none https://github.com/wineoflove/yeongho_opencode2.git $W/repos/oc2-custom
cd $W/repos/oc2-custom
git remote add upstream https://github.com/anomalyco/opencode.git
git config remote.upstream.tagopt --no-tags
git log --oneline -3
git tag -l "v$OC2_VERSION"   # 맥미니 기준 Release 태그
```

`main`은 우리 포크의 최신 소스이고, 맥미니가 운영 중인 버전은 Release 태그 `v$OC2_VERSION`입니다.

바이너리는 다음 둘 중 하나로 준비합니다.

**A. Release에서 내려받기 (권장)**

맥미니에서 운영 중인 바이너리와 같은 파일입니다. 바이너리는 200MB가 넘어서 Git 저장소에 넣지 않고 GitHub Release에 첨부합니다. Release 파일은 개당 2GiB까지 올릴 수 있고, 저장소 용량이나 clone 크기에 포함되지 않으며 무료입니다.

```bash
O=$S/opencode/$OC2_VERSION
mkdir -p $S/downloads/oc2 && cd $S/downloads/oc2
gh release download "v$OC2_VERSION" -R wineoflove/yeongho_opencode2 --clobber
shasum -a 256 -c SHA256SUMS --ignore-missing          # tar.gz 확인
install -d -m 700 $O
tar -xzf "opencode-$OC2_VERSION-darwin-arm64.tar.gz" -C $O
[ "$(shasum -a 256 $O/opencode | cut -d' ' -f1)" = "$OC2_SHA256" ] && echo "opencode SHA-256 OK" || echo "SHA-256 불일치" >&2
xattr -d com.apple.quarantine $O/opencode 2>/dev/null || true
env -i HOME=$S/home PATH=/usr/bin:/bin $O/opencode --version   # v$OC2_VERSION
```

**B. 소스에서 빌드**

Release 태그 `v$OC2_VERSION`의 소스를 그 소스가 지정한 Bun 버전으로 빌드합니다.

```bash
SRC=$S/run/oc2-src-$OC2_VERSION
OUT=$S/run/oc2-artifact-$OC2_VERSION  # 반드시 새 경로. 빌드 스크립트가 outdir을 지우고 시작합니다.
git -C $W/repos/oc2-custom fetch -q origin "refs/tags/v$OC2_VERSION:refs/tags/v$OC2_VERSION"
git -C $W/repos/oc2-custom worktree add --detach $SRC "v$OC2_VERSION"
BUILD_BUN=$(jq -r '.packageManager | sub("^bun@"; "")' $SRC/package.json); echo "build bun $BUILD_BUN"
mkdir -p $S/toolchains/bun-$BUILD_BUN && cd $S/toolchains/bun-$BUILD_BUN
curl -fLO https://github.com/oven-sh/bun/releases/download/bun-v$BUILD_BUN/bun-darwin-aarch64.zip
curl -fLO https://github.com/oven-sh/bun/releases/download/bun-v$BUILD_BUN/SHASUMS256.txt
grep ' bun-darwin-aarch64.zip$' SHASUMS256.txt | shasum -a 256 -c - && unzip -oq bun-darwin-aarch64.zip
BUNDIR=$S/toolchains/bun-$BUILD_BUN/bun-darwin-aarch64
mkdir -p $S/run/oc2-build-home/{.config,.local/share,.local/state,.cache,tmp}
BENV=(env -i HOME=$S/run/oc2-build-home PATH=$BUNDIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
      XDG_CONFIG_HOME=$S/run/oc2-build-home/.config XDG_DATA_HOME=$S/run/oc2-build-home/.local/share
      XDG_STATE_HOME=$S/run/oc2-build-home/.local/state XDG_CACHE_HOME=$S/run/oc2-build-home/.cache
      TMPDIR=$S/run/oc2-build-home/tmp)
cd $SRC
"${BENV[@]}" $BUNDIR/bun --no-env-file install --frozen-lockfile --ignore-scripts
"${BENV[@]}" OPENCODE_CHANNEL=ocm-pool OPENCODE_VERSION=$OC2_VERSION CI=true \
  $BUNDIR/bun --no-env-file run packages/cli/script/build.ts --single --skip-install --skip-web-ui --outdir=$OUT
install -d -m 700 $S/opencode/$OC2_VERSION
cp $OUT/cli-darwin-arm64/bin/opencode $S/opencode/$OC2_VERSION/opencode
$S/opencode/$OC2_VERSION/opencode --version
git -C $W/repos/oc2-custom worktree remove $SRC
```

B 방식으로 빌드한 바이너리는 A와 해시가 비트 단위로 같지 않을 수 있습니다. 버전 문자열과 이후의 동작 확인으로 검증합니다.

### 4.4 워크스페이스 설정·스킬·학습 저장소 복원

`ocm-workspace-config`는 git dir를 작업 트리 **밖**에 둡니다. `data/workspace` 안에 `.git`을 만들면 OpenCode의 프로젝트 식별이 바뀌어 세션 생성이 깨지므로, `git init`이나 `git clone`을 워크스페이스에 직접 실행하지 않습니다.

먼저 이 Mac의 브랜치(`$CONFIG_BRANCH`)가 원격에 이미 있는지 확인합니다. `git ls-remote --exit-code`의 종료 코드로 갈 길을 정합니다.

```bash
echo "$CONFIG_BRANCH"
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code https://github.com/wineoflove/ocm-workspace-config.git \
  "refs/heads/$CONFIG_BRANCH" >/dev/null
case $? in
  0) echo "원격에 $CONFIG_BRANCH가 있습니다 → 4.4-B 재설치" ;;
  2) echo "원격에 $CONFIG_BRANCH가 없습니다 → 4.4-A 신규 설치" ;;
  *) echo "확인 실패(인증·네트워크 오류). 3.2의 완료 확인과 인터넷 연결을 점검한 뒤 다시 실행하세요." >&2 ;;
esac
```

| 종료 코드 | 뜻 | 다음 |
| --- | --- | --- |
| `0` | 원격에 이 Mac 브랜치가 있음. 같은 Mac·계정을 다시 설치하는 경우 | [4.4-B](#44-b-재설치) |
| `2` | 저장소에는 접근했고 이 브랜치만 없음 | [4.4-A](#44-a-신규-설치) |
| 그 외(예: `128`) | 인증 실패, 권한 없음, 네트워크 오류 | 신규 설치로 넘어가지 않습니다. 3.2 완료 확인부터 다시 봅니다 |

다른 기기와 이름이 겹친 경우(`0`인데 이 Mac 브랜치가 아님)에는 `$S/env/config-branch`에 다른 이름을 직접 쓰고, 새 터미널에서 공통 변수를 다시 설정한 뒤 위 확인부터 다시 합니다.

학습 저장소는 맥미니가 매일 05:00에 `macmini` 브랜치로 백업한 내용입니다. 더 최신 기록이 필요하면 맥미니에서 설정 백업 스케줄을 수동으로 한 번 실행한 뒤 진행합니다.

#### 4.4-A 신규 설치

맥미니의 `macmini` 브랜치를 한 번 복사해 오고, 곧바로 이 Mac 전용 브랜치로 전환합니다.

**[확인]** `$G`(git dir)와 워크스페이스의 설정 파일을 새로 만듭니다. 이전 시도의 잔여물이 있으면 멈춥니다.

```bash
if [ -e "$G" ] || [ -e "$S/run/wc-tmp" ]; then
  echo "이미 있습니다: $G 또는 $S/run/wc-tmp. 이전 시도의 잔여물인지 확인한 뒤 옮기거나 지우고 다시 실행하세요." >&2
else
  git clone --no-checkout -b macmini https://github.com/wineoflove/ocm-workspace-config.git $S/run/wc-tmp &&
  mv $S/run/wc-tmp/.git $G && rmdir $S/run/wc-tmp &&
  git --git-dir=$G config core.worktree $W &&
  git --git-dir=$G --work-tree=$W checkout -b "$CONFIG_BRANCH" &&
  git --git-dir=$G --work-tree=$W checkout HEAD -- . &&
  git --git-dir=$G branch -D macmini &&                # 로컬 macmini를 지워 실수로 push하지 않게. origin/macmini는 남김
  git --git-dir=$G config "branch.$CONFIG_BRANCH.forkedFrom" "$(git --git-dir=$G rev-parse origin/macmini)" &&
  printf '%s\n' "$CONFIG_BRANCH" > $S/env/config-branch &&
  git --git-dir=$G branch -vv
fi
```

`forkedFrom`에는 복사해 온 맥미니 커밋이 기록됩니다. 나중에 맥미니 변경을 가져올 때([12.5](#125-워크스페이스-설정스킬)) 기준으로 씁니다.

다음 파일들을 지웁니다. `macmini` 브랜치는 2026-11-27에 OC1 잔재를 정리했으므로, 보통은 Manager 생성 플러그인만 대상이 됩니다. 목록이 비어 있어도 정상입니다.
- OC1 시절 파일(이전 백업에서 받았다면). 특히 `opencode.json`은 OC1 형식이라 반드시 지웁니다.
- Manager가 기동할 때 다시 만드는 플러그인(`plugins/ocm-*.js`)

**[확인]** 지울 대상만 먼저 출력합니다. 목록을 확인한 다음 두 번째 블록을 실행합니다.

```bash
cd $W
ls -d .config/opencode/skills-archive .config/opencode/skills/opencode-account-recovery \
      .config/opencode/opencode.json .config/opencode/tui.json .config/opencode/agents/goal-runner.md \
      .config/opencode/anthropic-pool-admin.mjs .config/opencode/plugins/ocm-*.js \
      repos/assistant/.opencode/tests/goal-runner-session-scope.test.mjs 2>/dev/null
```

```bash
cd $W
rm -rf .config/opencode/skills-archive .config/opencode/skills/opencode-account-recovery
rm -f .config/opencode/opencode.json .config/opencode/tui.json \
      .config/opencode/agents/goal-runner.md .config/opencode/anthropic-pool-admin.mjs \
      .config/opencode/plugins/ocm-*.js \
      repos/assistant/.opencode/tests/goal-runner-session-scope.test.mjs
ls .config/opencode/skills | wc -l      # 38
ls .config/opencode/agents | wc -l      # 19 (sisyphus, prometheus, hephaestus, oracle, … junior-*)
```

이어서 4.5, 4.6, 4.7을 진행합니다.

#### 4.4-B 재설치

원격의 이 Mac 브랜치에는 이미 정리·경로 변환·포트 적용이 된 설정이 있습니다. 그 브랜치를 그대로 복원하고, 번들에서는 **없는 파일만** 채웁니다. 4.4-A의 정리, 4.5~4.7은 하지 않습니다.

**[확인]** `$G`와 워크스페이스 설정 파일을 원격 브랜치 내용으로 만듭니다.

```bash
if [ -e "$G" ] || [ -e "$S/run/wc-tmp" ]; then
  echo "이미 있습니다: $G 또는 $S/run/wc-tmp. 이전 시도의 잔여물인지 확인한 뒤 진행하세요." >&2
else
  git clone --no-checkout -b "$CONFIG_BRANCH" https://github.com/wineoflove/ocm-workspace-config.git $S/run/wc-tmp &&
  mv $S/run/wc-tmp/.git $G && rmdir $S/run/wc-tmp &&
  git --git-dir=$G config core.worktree $W &&
  git --git-dir=$G --work-tree=$W checkout HEAD -- . &&
  printf '%s\n' "$CONFIG_BRANCH" > $S/env/config-branch &&
  git --git-dir=$G branch -vv
fi
```

맥미니 기준점(`forkedFrom`)을 브랜치의 커밋 기록에서 복원합니다. 커밋 메시지의 `Macmini-Base:` 줄이나 `… from macmini <SHA>` 제목을 읽고, 둘 다 없으면 갈라진 지점(merge-base)을 씁니다.

```bash
BASE=$(git --git-dir=$G log --format=%B "$CONFIG_BRANCH" \
  | sed -nE 's/^Macmini-Base: ([0-9a-f]{40})$/\1/p; s/.* from macmini ([0-9a-f]{7,40})$/\1/p' | head -1)
BASE=$(git --git-dir=$G rev-parse --verify -q "${BASE:-none}^{commit}" \
  || git --git-dir=$G merge-base "$CONFIG_BRANCH" origin/macmini)
git --git-dir=$G config "branch.$CONFIG_BRANCH.forkedFrom" "$BASE"
git --git-dir=$G log --oneline -1 "$BASE"
```

번들은 없는 파일만 채웁니다. 워크스페이스의 파일(`opencode.jsonc`, `schedule-reports.json` 등)은 브랜치에 있는 이 Mac 값을 그대로 씁니다.

```bash
B=$S/run/new-mac-bundle; rm -rf $B; mkdir -p $B
(cd $S/port/deploy/new-mac && shasum -a 256 -c SHA256SUMS) && tar -xzf $S/port/deploy/new-mac/oc2-macmini-bundle.tgz -C $B
rsync -ani --ignore-existing "$B/home/" "$U/" | awk '$1 ~ /^>f/ {print "새 파일: " $2}'
```

**[확인]** 위 목록(새로 채울 파일)을 확인한 다음 적용합니다. 새로 채운 파일에만 경로 변환과 포트를 적용합니다.

```bash
B=$S/run/new-mac-bundle
if [ ! -f "$B/meta/manifest.json" ] || [ ! -d "$B/home" ]; then
  echo "$B에 풀린 번들이 없습니다. 바로 위 블록부터 다시 실행하세요." >&2
else
  rsync -ai --ignore-existing "$B/home/" "$U/" | awk -v home="$U" '$1 ~ /^>f/ {print home "/" $2}' > $S/run/new-mac-added.txt
  rm -rf $S/run/new-mac-meta && cp -R $B/meta $S/run/new-mac-meta
  bash $S/port/deploy/new-mac/relocate.sh "$(jq -r .sourceHome $S/run/new-mac-meta/manifest.json)" \
    $S/run/new-mac-meta/schedules.json
  tr '\n' '\0' < $S/run/new-mac-added.txt | xargs -0 -r bash $S/port/deploy/new-mac/set-ports.sh --source $S/env/ports.env
  (umask 077; cp $S/env/ports.env $S/env/ports.applied.env)
  git --git-dir=$G --work-tree=$W status --short | head -20
fi
```

- `relocate.sh`는 브랜치 파일에서 바꿀 경로를 찾지 못하면 그대로 둡니다. 새로 채운 파일만 바뀝니다.
- `git status`에 바뀐 파일이 나오면 이 Mac의 사용자명이나 포트가 브랜치를 만들 때와 달라진 것입니다. 내용을 확인하고 4.7과 같은 방식으로 커밋해 push합니다.
- 스케줄과 보고 세션 ID는 새 Manager DB에 맞춰 [10](#10-학습점검-스케줄-범위-3)에서 다시 연결합니다. 브랜치의 `schedule-reports.json`에 있는 예전 ID는 그때 바뀝니다.

그다음은 [5](#5-cliproxy-범위-2)부터 진행합니다.

### 4.5 맥미니 번들 풀기와 경로 변환

`deploy/new-mac/oc2-macmini-bundle.tgz`는 Git에 없는 맥미니 운영 파일을 모은 묶음입니다. 비밀값은 들어 있지 않습니다. `make-bundle.sh`가 묶을 때 알려진 키 값과 토큰 형태의 문자열을 검사하고, 발견되면 묶기를 거부합니다.

| 번들 안 위치 | 내용 |
| --- | --- |
| `home/apps/ocm-v2-staging/bin/` | `launchd-backend.sh`, `start/stop/restart/status.sh`, `build-oc2.sh`, `deploy-oc2-code.sh`, `oc2-active.mjs`, `cleanup-rr-sessions.mjs` |
| `home/apps/mcp-shared/` | 공용 MCP 서버 스크립트(`write-plists.py`, `exa-proxy.mjs`, `firecrawl.sh`, `loopback-guard.mjs`, smoke 테스트) |
| `home/…/.config/opencode/opencode.jsonc` | OC2 전역 설정. CLIProxy 키 경로는 `cliproxy/package`, codegraph는 `~/.codegraph`로 이미 맞춰져 있음 |
| `home/…/.opencode/tooling/` | claude-design-mcp 소스, playwright·ui-automation wrapper, MCP npm `package.json`·lock |
| `home/…/repos/assistant/.opencode/` | `bin/schedule-report.mjs`, `schedule-reports.json`(맥미니 ID, [10](#10-학습점검-스케줄-범위-3)에서 교체) |
| `home/Library/LaunchAgents/` | Manager 백엔드·Headroom plist. Headroom은 새 venv 위치로 맞춰져 있음 |
| `meta/` | `schedules.json`(Assistant 스케줄 정의), `headroom-requirements.txt`, `markitdown-requirements.txt`, `manifest.json`(원본 HOME·OC2 버전·해시·맥미니 포트) |

번들을 풀고, 적용하기 전에 새로 생길 파일과 덮어쓸 파일을 미리 봅니다.

```bash
B=$S/run/new-mac-bundle; rm -rf $B; mkdir -p $B
(cd $S/port/deploy/new-mac && shasum -a 256 -c SHA256SUMS) && tar -xzf $S/port/deploy/new-mac/oc2-macmini-bundle.tgz -C $B
jq . $B/meta/manifest.json
rsync -ani "$B/home/" "$U/" | awk '$1 ~ /^>f/ { if ($1 ~ /^>f\+/) add++; else { chg++; print "덮어씀: " $2 } }
  END { printf "새 파일 %d개, 덮어쓸 파일 %d개\n", add, chg }'
```

**[확인]** 신규 설치라면 `덮어쓸 파일 0개`가 정상입니다. 덮어쓸 파일이 있으면 이전 시도의 잔여물인지, 이 Mac에서 직접 고친 파일인지 확인합니다. 아래 명령은 덮어쓰는 파일의 원본을 `<파일>.before-bundle`로 남깁니다.

```bash
B=$S/run/new-mac-bundle
if [ ! -f "$B/meta/manifest.json" ] || [ ! -d "$B/home" ]; then
  echo "$B에 풀린 번들이 없습니다. 바로 위 블록부터 다시 실행하세요." >&2
else
  rsync -a --backup --suffix=.before-bundle "$B/home/" "$U/"      # HOME 아래 같은 상대 위치에 놓임
  rm -rf $S/run/new-mac-meta && cp -R $B/meta $S/run/new-mac-meta
  find "$U/apps" "$U/Library/LaunchAgents" -name '*.before-bundle' 2>/dev/null   # 남은 원본. 확인 후 지웁니다
fi
```

맥미니 HOME을 이 Mac의 HOME으로 바꿉니다.

```bash
bash $S/port/deploy/new-mac/relocate.sh "$(jq -r .sourceHome $S/run/new-mac-meta/manifest.json)" \
  $S/run/new-mac-meta/schedules.json
```

- 대상: 운영 스크립트, MCP 스크립트, `.config/opencode`(지침·에이전트·스킬·설정), Assistant 지침·문서·bin, 학습 설정 파일, tooling wrapper, launchd plist(`USER`/`LOGNAME` 포함), 스케줄 정의
- 학습 기록(`.opencode/learnings/entries`, `reviews`, `applications`)은 과거의 증거이므로 바꾸지 않습니다.
- 경로 뒤에 사용자명이 이어지는 경우(예: `/Users/yeonghokimx`)는 다른 계정으로 보고 건드리지 않습니다.
- 끝까지 바뀌지 않은 곳이 있으면 목록을 출력하고 exit 1로 끝납니다. 그 파일만 직접 확인합니다.
- 같은 사용자명이면 "nothing to relocate"를 출력하고 끝납니다. 다시 실행해도 결과는 같습니다.
- 워크스페이스 설정 저장소에서는 바뀐 파일이 수정으로 보입니다. 이 Mac 전용 차이이며, 4.7에서 첫 커밋으로 올립니다.

### 4.6 포트 적용

맥미니에서 가져온 파일의 포트를 [1.1](#11-포트-정하기)의 값으로 바꿉니다.

```bash
bash $S/port/deploy/new-mac/set-ports.sh $S/env/ports.env
```

- 맥미니 포트는 번들 `manifest.json`의 `ports`에서 읽습니다. 바꾼 결과는 `$S/env/ports.applied.env`에 기록되어, 다음에 다시 실행할 때 기준이 됩니다.
- 대상은 4.5와 같은 운영 파일입니다(운영 스크립트, MCP 스크립트·README, `opencode.jsonc`, Headroom plist, 지침의 포트 목록).
  - 지침 파일은 전역 `AGENTS.md`, `assistant.md`, `learning-follow-through.md`, `webapp-testing` 스킬입니다. 에이전트가 이 목록을 보고 OC2 서비스 포트를 피하기 때문에 함께 바꿉니다.
  - 학습 기록은 바꾸지 않습니다.
- 포트 번호 앞뒤에 다른 숫자나 영문자가 붙어 있으면(해시, ID 등) 바꾸지 않습니다. 포트끼리 맞바꿔도(예: 5106↔5107) 섞이지 않습니다.
- 값이 9개 모두 있고, 서로 다르며, 1024~65535 범위이고 `5003`·`5551`이 아니어야 합니다. 아니면 아무것도 바꾸지 않고 끝납니다.
- 같은 값으로 다시 실행하면 바뀌는 파일이 없습니다.
- 마지막에 이미 다른 프로세스가 대기 중인 포트가 있으면 `note:`로 알려 줍니다.

전역 `AGENTS.md`의 "Dev Server Ports" 절에는 맥미니에만 있는 다른 서비스(예약 시스템, OpenClaw 등)의 포트도 적혀 있습니다. 이 Mac에서 실제로 쓰는 서비스에 맞게 직접 고쳐 두면 에이전트가 포트를 고를 때 정확해집니다.

확인:

```bash
grep -n 'apiKey\|baseURL\|"url"' $W/.config/opencode/opencode.jsonc
grep -n 'for port in' $S/bin/launchd-backend.sh $S/bin/status.sh
ls $W/.config/opencode $W/repos/assistant/.opencode/agents
```

```jsonc
// providers.openai.settings
"baseURL": "http://127.0.0.1:<HEADROOM_PORT>/v1",             // Headroom → CLIProxy
"apiKey": "{file:<HOME>/apps/ocm-v2-staging/cliproxy/package/keys/upstream.key}"
// providers.anthropic.settings
"baseURL": "http://127.0.0.1:<MANAGER_PORT>/api/claude-inference/v1",   // Manager 게이트 → Headroom → CLIProxy
"apiKey": "{file:<HOME>/apps/ocm-v2-staging/cliproxy/package/keys/ingress.key}"
```

전역 모델은 `openai/gpt-6.1-sol`입니다. MCP 8개(`ref`, `context7`, `markitdown`, `playwright`, `firecrawl`, `codegraph`, `claude-design`, `websearch`)와 TypeScript LSP도 같은 파일에 정의되어 있습니다. 키 값은 파일에 직접 쓰지 않고 `{file:…}`로만 참조합니다.

### 4.7 전용 브랜치 첫 커밋

4.4~4.6을 거친 상태(OC1 잔재 정리, 경로 변환, 포트 적용, 번들 파일 추가)를 이 Mac 전용 브랜치의 첫 커밋으로 만들고 원격에 올립니다. 이 커밋이 이 Mac의 기준이 되어, 이후에는 "이 Mac 전용 차이"와 "새로 바뀐 내용"을 구분할 수 있습니다.

먼저 Manager가 생성하는 파일이 추적되지 않도록 제외 규칙을 추가합니다. `service-ocm-pool.json`에는 OC2 서버 비밀번호가 들어가므로 반드시 제외합니다.

```bash
cd $W
for rule in '/.config/opencode/service-ocm-pool.json' '/.config/opencode/plugins/ocm-*.js'; do
  grep -qxF "$rule" .gitignore || printf '%s\n' "$rule" >> .gitignore
done
```

바뀐 파일 목록을 확인합니다.

```bash
GW=(git --git-dir=$G --work-tree=$W)
"${GW[@]}" status --short | sed -n '1,80p'
```

예상되는 내용은 다음과 같습니다. 이 외의 파일이 있으면 무엇인지 확인한 다음 진행합니다.

| 상태 | 파일 |
| --- | --- |
| ` D` 삭제 | `plugins/ocm-*.js`. 이전 백업에서 받았다면 OC1 파일(`skills-archive/…`, `opencode.json`, `tui.json` 등)도 |
| ` M` 수정 | `.gitignore`. 사용자명이나 포트가 다르면 경로·포트가 바뀐 지침·설정 파일 |
| `??` 새 파일 | 번들에서 온 `.config/opencode/opencode.jsonc`, `repos/assistant/.opencode/bin/schedule-report.mjs`, `repos/assistant/.opencode/schedule-reports.json` |

확인한 파일만 경로를 지정해 stage합니다. 경로 없이 쓰는 `add .`, `add -A`, `add -u`는 쓰지 않습니다. 추적 중인 파일의 수정·삭제는 `add --update -- <파일…>`로 넣습니다. `.opencode/tooling/lsp` 처럼 상위 폴더가 제외 규칙에 걸린 추적 파일도 이 방식이면 stage할 수 있습니다. 비밀값으로 보이는 이름이 섞이면 stage를 취소하고 멈춥니다.

```bash
{ "${GW[@]}" ls-files -z --deleted; "${GW[@]}" ls-files -z --modified; } \
  | sort -zu | xargs -0 -r "${GW[@]}" add --update --
"${GW[@]}" add -- .config/opencode/opencode.jsonc \
  repos/assistant/.opencode/bin/schedule-report.mjs repos/assistant/.opencode/schedule-reports.json
if "${GW[@]}" diff --cached --name-only | grep -Ei 'service-ocm-pool|secret|token|credential|auth\.json|\.key$|\.pem$|\.env|\.db$|\.sqlite'; then
  echo "비밀값으로 보이는 파일이 stage되었습니다. stage를 취소합니다." >&2
  "${GW[@]}" reset -q
else
  "${GW[@]}" diff --cached --stat | tail -3
fi
```

커밋하고 원격에 올립니다.

```bash
BASE=$(git --git-dir=$G config "branch.$CONFIG_BRANCH.forkedFrom")
"${GW[@]}" commit -m "chore(config): $CONFIG_BRANCH baseline from macmini ${BASE:0:8}" -m "Macmini-Base: $BASE"
"${GW[@]}" push -u origin "$CONFIG_BRANCH"
[ "$(git --git-dir=$G ls-remote origin "refs/heads/$CONFIG_BRANCH" | cut -f1)" = "$(git --git-dir=$G rev-parse HEAD)" ] \
  && echo "원격 반영 확인: $CONFIG_BRANCH" || echo "원격 SHA가 다릅니다. 확인하세요." >&2
"${GW[@]}" status --short | head       # 비어 있어야 함
```

- 커밋 메시지의 `Macmini-Base:` 줄은 재설치할 때([4.4-B](#44-b-재설치)) 맥미니 기준점을 복원하는 데 씁니다.
- 이후 이 Mac의 설정 변경은 이 브랜치에만 백업합니다. 백업은 [10.4](#104-선택-설정-백업-스케줄) 스케줄이나 수동으로 합니다.
- `macmini` 브랜치는 맥미니 변경 사항을 참고할 때만 읽습니다([12.5](#125-워크스페이스-설정스킬)).
- Manager를 기동하면 `plugins/ocm-*.js`와 `service-ocm-pool.json`이 다시 생기지만, 위 제외 규칙 때문에 추적되지 않습니다.

---

## 5. CLIProxy (범위 2)

### 5.1 바이너리 받기·검증

```bash
mkdir -p $S/downloads/cliproxy && cd $S/downloads/cliproxy
A=CLIProxyAPI_${CLIPROXY_VERSION}_darwin_aarch64.tar.gz
curl -fLO https://github.com/router-for-me/CLIProxyAPI/releases/download/v$CLIPROXY_VERSION/$A
[ "$(shasum -a 256 $A | cut -d' ' -f1)" = "$CLIPROXY_TGZ_SHA256" ] && echo "tar.gz SHA-256 OK" || echo "tar.gz SHA-256 불일치" >&2
tar xzf $A cli-proxy-api
[ "$(shasum -a 256 cli-proxy-api | cut -d' ' -f1)" = "$CLIPROXY_BIN_SHA256" ] && echo "binary SHA-256 OK" || echo "binary SHA-256 불일치" >&2
xattr -d com.apple.quarantine cli-proxy-api 2>/dev/null || true
```

### 5.2 실행 패키지 생성

OCM 포크의 `prepareClaudeProxyPackage`를 사용합니다. 이 함수가 디렉터리, 무작위 키 3개(`ingress`/`upstream`/`management`), 게이트, `config.yaml`, launchd plist를 만듭니다. 맥미니도 같은 함수로 만들었습니다. 키는 이 Mac에서 새로 생성되며 맥미니 키와 다릅니다.

패키지 폴더가 이미 있으면 함수가 `EEXIST`로 멈춥니다. 재개할 때 이미 만들어져 있다면 이 블록은 건너뜁니다.

```bash
mkdir -p $S/cliproxy
cd $S/port
DEST=$S/cliproxy/package BIN=$S/downloads/cliproxy/cli-proxy-api PORT=$CLIPROXY_PORT \
SHA=$CLIPROXY_BIN_SHA256 \
bun -e '
import { prepareClaudeProxyPackage } from "./backend/src/services/claude-proxy-package.ts";
console.log(await prepareClaudeProxyPackage({
  destination: process.env.DEST, binary: process.env.BIN,
  binarySha256: process.env.SHA, port: Number(process.env.PORT) }));'
ls -la $S/cliproxy/package $S/cliproxy/package/keys
```

맥미니의 현재 설정에 맞춰 사용량 통계를 켭니다. Manager의 계정별 사용량 표시에 쓰입니다.

```bash
CFG=$S/cliproxy/package/config.yaml python3 - <<'EOF'
import json, os
p = os.environ["CFG"]
c = json.load(open(p))
c["observability"]["usage"] = {"usage-statistics-enabled": True, "redis-usage-queue-retention-seconds": 300}
json.dump(c, open(p, "w"), indent=2)
EOF
```

나머지 설정은 맥미니와 같습니다. `0.0.0.0:$CLIPROXY_PORT`에서 대기하고, `management.allow-remote: false`와 `disable-control-panel: true`로 원격 관리를 막습니다. 라우팅은 `round-robin`, `session-affinity: false`, `request-retry: 0`, `max-retry-credentials: 1`이고 Claude `server-side-fallback`은 꺼져 있습니다.

### 5.3 launchd 등록·확인

**[확인]** launchd에 CLIProxy를 등록합니다. 이미 등록돼 있으면 `bootstrap`이 오류(`Bootstrap failed: 5`)를 내니, 그때는 `launchctl print gui/$(id -u)/com.aion.ocm.claude-proxy`로 상태만 확인합니다.

```bash
cp $S/cliproxy/package/com.aion.ocm.claude-proxy.plist $U/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) $U/Library/LaunchAgents/com.aion.ocm.claude-proxy.plist
launchctl kickstart gui/$(id -u)/com.aion.ocm.claude-proxy
lsof -nP -iTCP:$CLIPROXY_PORT -sTCP:LISTEN
curl -s -D - -o /dev/null -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/management.key)" \
  http://127.0.0.1:$CLIPROXY_PORT/v8/management/credentials | grep -i '^x-cpa-version'   # $CLIPROXY_VERSION
```

계정은 Manager를 띄운 다음 UI에서 추가합니다([8.3](#83-cliproxy-계정-로그인)).

---

## 6. Headroom (범위 2)

```bash
H=$T/headroom
uv venv --python 3.12 $H/.venv
uv pip install --python $H/.venv/bin/python -r $S/run/new-mac-meta/headroom-requirements.txt
$H/.venv/bin/python -m headroom.cli --version     # $HEADROOM_VERSION

P=$U/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist
plutil -extract ProgramArguments.0 raw $P                     # $H/.venv/bin/python 이어야 함
ls "$(plutil -extract EnvironmentVariables.ORT_DYLIB_PATH raw $P)"
mkdir -p $S/run/headroom/tmp
plutil -lint $P
launchctl bootstrap gui/$(id -u) $P      # [확인] launchd 등록
sleep 5; curl -s http://127.0.0.1:$HEADROOM_PORT/health; echo
```

plist의 핵심 인자는 맥미니와 같습니다: `proxy --host 127.0.0.1 --port <HEADROOM_PORT> --stateless --no-telemetry --no-subscription-tracking --retry-max-attempts 1 --connect-timeout-seconds 3 --lossless`. `ANTHROPIC_TARGET_API_URL`와 `OPENAI_TARGET_API_URL`은 모두 `http://127.0.0.1:<CLIPROXY_PORT>`(CLIProxy)입니다. 포트 값은 4.6에서 이미 이 Mac 기준으로 바뀌었습니다. Headroom이 쓰는 Hugging Face 모델(약 260MB)은 처음 기동할 때 `$HOME/.cache/huggingface`에 내려받습니다.

---

## 7. MCP와 로컬 도구 (범위 4)

### 7.1 공용 MCP 서버 (context7·firecrawl·markitdown·exa)

번들에 들어 있는 lock 파일로 맥미니와 같은 버전을 설치합니다.

```bash
for n in context7 firecrawl playwright; do npm ci --prefix $T/npm-mcp/$n; done
uv venv --python 3.10 $T/markitdown/.venv
uv pip install --python $T/markitdown/.venv/bin/python -r $S/run/new-mac-meta/markitdown-requirements.txt
```

**[직접]** API 키는 이 Mac에서 직접 입력합니다. 기기별로 키를 새로 발급하면 폐기를 기기 단위로 할 수 있어 권장합니다. 기존 키를 다시 써도 동작은 같습니다.

```bash
install -d -m 700 $U/.local/share/opencode-manager/secrets $U/.local/share/ocm-migration-20260930/private
umask 077
read -rs "EK?Exa API 키: "; echo; printf '%s' "$EK" > $U/.local/share/opencode-manager/secrets/exa-api-key; unset EK
read -rs "FK?Firecrawl API 키: "; echo
jq -n --arg k "$FK" '{mcpServers:{firecrawl:{env:{FIRECRAWL_API_KEY:$k}}}}' \
  > $U/.local/share/ocm-migration-20260930/private/mcporter.json; unset FK
chmod 600 $U/.local/share/opencode-manager/secrets/exa-api-key $U/.local/share/ocm-migration-20260930/private/mcporter.json
```

완료 확인(값은 출력하지 않고 권한·크기만 봅니다):

```bash
stat -f '%Lp %z %N' $U/.local/share/opencode-manager/secrets/exa-api-key $U/.local/share/ocm-migration-20260930/private/mcporter.json   # 600, 크기 0보다 큼
jq -e '.mcpServers.firecrawl.env.FIRECRAWL_API_KEY | length > 0' $U/.local/share/ocm-migration-20260930/private/mcporter.json >/dev/null && echo "firecrawl key ok"
```

실제 키가 유효한지는 아래 `call-smoke.mjs`로 확인합니다.

`firecrawl.sh`는 맥미니와 같은 위치(`ocm-migration-20260930/private/mcporter.json`)에서 키를 읽습니다. 경로 이름은 맥미니 이력 때문이며, 내용은 Firecrawl 키 하나면 충분합니다.

**[확인]** plist 4개를 만들고 launchd에 등록합니다. `write-plists.py`는 같은 이름의 plist를 덮어씁니다.

```bash
mkdir -p $U/apps/mcp-shared/logs
python3 $U/apps/mcp-shared/bin/write-plists.py     # $HOME/Library/LaunchAgents/io.wineoflove.mcp.*.plist 생성
for n in context7 firecrawl markitdown exa; do
  launchctl bootstrap gui/$(id -u) $U/Library/LaunchAgents/io.wineoflove.mcp.$n.plist
done
sleep 3; for p in $CONTEXT7_PORT $FIRECRAWL_PORT $MARKITDOWN_PORT $EXA_PORT; do lsof -nP -iTCP:$p -sTCP:LISTEN | tail -1; done
node $U/apps/mcp-shared/bin/smoke.mjs        # 도구 목록·동시 접속·Host 거부
node $U/apps/mcp-shared/bin/call-smoke.mjs   # 실제 도구 호출 (Exa·Firecrawl 크레딧을 소량 사용)
```

### 7.2 Playwright MCP (Chrome 확장 방식)

**[직접]**
1. Chrome을 설치하고, 사용할 프로필에 **Playwright MCP Bridge** 확장을 설치합니다.
2. 확장에 표시되는 토큰을 저장합니다.

   ```bash
   read -rs "PWT?Playwright 확장 토큰: "; echo
   (umask 077; printf '%s' "$PWT" > $U/.local/share/opencode-manager/secrets/playwright-extension-token); unset PWT
   chmod 600 $U/.local/share/opencode-manager/secrets/playwright-extension-token
   ```

3. wrapper를 확장을 설치한 Chrome 프로필로 맞춥니다. `$T/playwright-mcp`는 맥미니 값(`--user-data-dir`은 맥미니 전용 폴더, `--profile-dir-name`은 `Profile 3`)을 가리키고 있습니다.
   - 확장을 설치한 프로필에서 `chrome://version`을 열고 **프로필 경로**를 복사합니다.
   - 경로의 마지막 부분이 프로필 이름(`--profile-dir-name`)이고, 그 앞부분이 사용자 데이터 폴더(`--user-data-dir`)입니다.

   예: 프로필 경로가 `/Users/<계정>/Library/Application Support/Google/Chrome/Default`이면 다음과 같이 맞춥니다.

   | 옵션 | 값 |
   | --- | --- |
   | `--user-data-dir` | `/Users/<계정>/Library/Application Support/Google/Chrome` |
   | `--profile-dir-name` | `Default` |

   ```bash
   PROFILE_PATH="$HOME/Library/Application Support/Google/Chrome/Default"   # chrome://version의 프로필 경로를 그대로 붙여 넣기
   PROFILE_PATH="$PROFILE_PATH" F=$T/playwright-mcp python3 - <<'EOF'
   import os, re, shlex
   path, profile = os.environ["F"], os.environ["PROFILE_PATH"].rstrip("/")
   data_dir, name = os.path.dirname(profile), os.path.basename(profile)
   text = open(path).read()
   text, n1 = re.subn(r"--user-data-dir '[^']*'", "--user-data-dir " + shlex.quote(data_dir), text)
   text, n2 = re.subn(r"--profile-dir-name '[^']*'", "--profile-dir-name " + shlex.quote(name), text)
   assert n1 == 1 and n2 == 1, "wrapper 형식이 달라 직접 고쳐야 합니다"
   open(path, "w").write(text)
   print(f"user-data-dir={data_dir} profile={name}")
   EOF
   grep -n 'user-data-dir\|profile-dir-name' $T/playwright-mcp
   ```

완료 확인: 토큰 파일이 `600`인지 `stat -f '%Lp %N' $U/.local/share/opencode-manager/secrets/playwright-extension-token`으로 봅니다. 연결은 Manager를 띄운 뒤 Assistant에게 "Playwright MCP로 `about:blank`를 열고 snapshot을 찍어 줘"라고 요청해 확인합니다. 지정한 프로필의 Chrome 창에 새 탭이 열려야 합니다.

### 7.3 codegraph

공식 설치 스크립트로 맥미니와 같은 버전(`CODEGRAPH_VERSION`)을 설치합니다. Node가 번들되어 있어 Homebrew node 버전과 상관없이 동작합니다.

```bash
curl -fsSL "https://raw.githubusercontent.com/colbymchenry/codegraph/v$CODEGRAPH_VERSION/install.sh" -o $S/downloads/codegraph-install.sh
CODEGRAPH_VERSION="v$CODEGRAPH_VERSION" sh $S/downloads/codegraph-install.sh
$U/.codegraph/current/bin/codegraph version      # $CODEGRAPH_VERSION
```

`opencode.jsonc`의 codegraph 명령은 `$HOME/.codegraph/current/bin/codegraph serve --mcp`입니다. 인덱스는 옮기지 않습니다. 필요한 프로젝트에서 직접 `codegraph init`을 실행하세요. 인덱싱은 영호 님이 결정하는 작업이며, 에이전트는 스스로 실행하지 않습니다. `codegraph install`(에이전트 자동 설정)은 실행하지 않습니다. OC2 설정은 이미 번들에 들어 있습니다.

### 7.4 claude-design

소스는 번들로 복원됩니다(`$T/claude-design-mcp`). Node 22 이상과 **Claude Code CLI 로그인**이 필요합니다. 일반 셸에서 `claude`를 설치하고 로그인해 두세요. MCP 명령은 `HOME=<사용자 HOME>`으로 실행되므로 Manager의 HOME이 아니라 사용자 HOME의 로그인을 사용합니다. Claude Desktop 앱(`/Applications/Claude.app`)에 번들된 CLI도 자동으로 찾습니다.

**[직접]** 일반 터미널에서 `claude auth login`으로 로그인합니다. 완료 확인: `claude auth status`가 로그인 상태를 보여 줍니다. MCP 연결은 Manager를 띄운 뒤 Assistant에서 claude-design의 `status` 도구로 확인합니다.

### 7.5 ref, websearch

- `ref`: 원격 `https://ref.theseeker.io/mcp`이며 인증이 필요 없습니다.
- `websearch`: 7.1의 Exa 프록시(`:$EXA_PORT`)입니다.

### 7.6 LSP와 UI 자동화 도구 (선택)

**TypeScript LSP**

```bash
(cd $T/lsp && pnpm install --frozen-lockfile)        # 워크스페이스 백업에 package.json·lock 포함
ln -sf $T/lsp/node_modules/typescript-language-server/lib/cli.mjs $U/.local/bin/typescript-language-server
```

설치 직후 테스트: 버전을 출력하고, 실제로 서버를 띄워 LSP `initialize` 요청에 응답하는지 확인합니다.

```bash
typescript-language-server --version                                     # lsp/package.json의 버전
TSSERVER=$T/lsp/node_modules/typescript/lib/tsserver.js \
  node $S/port/deploy/new-mac/lsp-check.mjs "$(command -v typescript-language-server)" $S/port
# initialize ok: 23 capabilities (hover=true, definition=true)
```

**UI 자동화** (`ui-automation` 스킬이 사용): agent-browser, agent-desktop(버전은 번들의 `ui-automation/package-lock.json`), cua-driver

```bash
npm ci --prefix $T/ui-automation
for t in agent-browser agent-desktop cua-driver; do ln -sf $T/ui-automation/bin/$t $U/.local/bin/$t; done
agent-browser --version; agent-desktop --version                          # package-lock.json과 같은 버전
```

`cua-driver`는 `/Applications/CuaDriver.app`을 공식 배포본으로 설치한 뒤 권한을 줍니다. 맥미니 버전은 `CUADRIVER_VERSION`입니다.

1. **[직접]** `cua-driver permissions grant`를 실행합니다. 시스템 설정의 **손쉬운 사용**과 **화면 기록** 스위치를 하나씩 안내하고, 마지막에 테스트 스크린샷으로 확인합니다.
2. 권한 상태를 확인합니다.

   ```bash
   cua-driver permissions status --json | jq '{accessibility, screen_recording}'    # 둘 다 true
   ```

3. 실제 창에서 UI 요소 읽기와 PNG 캡처가 되는지 확인합니다. Finder 창을 하나 열어 둔 상태에서 실행합니다(`open ~`). 캡처한 화면에는 개인 정보가 있을 수 있으므로 확인 후 바로 지웁니다.

   ```bash
   SES=setup-check
   read PID WID <<< "$(cua-driver call list_windows '{"app":"Finder","on_screen_only":true,"session":"'$SES'"}' \
     | jq -r '[.windows[] | select(.layer == 0)] | max_by(.bounds.width * .bounds.height) | "\(.pid) \(.window_id)"')"
   cua-driver call get_window_state "{\"pid\":$PID,\"window_id\":$WID,\"max_elements\":30,\"session\":\"$SES\"}" \
     --screenshot-out-file $S/tmp/cua-check.png | jq '{element_count, degraded_reason, screenshot_error}'
   file $S/tmp/cua-check.png                  # PNG image data
   cua-driver call end_session "{\"session\":\"$SES\"}" >/dev/null; rm -f $S/tmp/cua-check.png
   ```

   - 정상: `element_count`가 0보다 크고, `degraded_reason`·`screenshot_error`가 `null`이며, PNG 파일이 만들어집니다.
   - `degraded_reason`이 `screen_locked…`: 화면이 잠겼거나 화면 보호기가 켜진 상태입니다. 잠금을 풀고 다시 실행합니다.
   - `screenshot_error.reason`이 `direct_capture_consent_required…`: macOS가 직접 캡처 허용을 아직 묻지 않은 상태입니다. 뜨는 허용 창을 승인하고 다시 실행합니다.

---

## 8. Manager 기동 (범위 1·2 연결)

### 8.1 환경 파일

**[직접]** 관리자 이메일과 비밀번호를 입력합니다. 비밀값(관리자 비밀번호, `AUTH_SECRET`)은 입력만 받고 화면에 출력하지 않습니다. LAN IP는 기본 경로의 네트워크 인터페이스에서 자동으로 찾습니다. 찾지 못하면 멈추니, 그때는 `IP=192.168.x.x`처럼 직접 지정하고 다시 실행합니다.

**[확인]** 이미 `staging.env`가 있으면 만들지 않고 멈춥니다. 다시 만들면 `AUTH_SECRET`이 바뀌어 모든 로그인 세션이 끊깁니다. 관리자 비밀번호만 바꾸려면 [8.6](#86-관리자-비밀번호-재설정)을 따릅니다.

```bash
IP=${IP:-$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)}
echo "LAN IP: ${IP:-찾지 못함}"
if [ -z "$IP" ]; then echo "LAN IP를 찾지 못했습니다. IP=<이 Mac의 IP>로 지정한 뒤 다시 실행하세요." >&2
elif [ -e $S/env/staging.env ]; then echo "$S/env/staging.env가 이미 있습니다. 8.6을 확인하세요." >&2
else
read -r  "ADMIN_EMAIL?관리자 이메일: "
read -rs "ADMIN_PASSWORD?관리자 비밀번호: "; echo
umask 077
cat > $S/env/staging.env <<EOF
NODE_ENV=production
LOG_LEVEL=info
HOST=0.0.0.0
PORT=$MANAGER_PORT
CORS_ORIGIN=http://$IP:$MANAGER_PORT
AUTH_TRUSTED_ORIGINS=http://$IP:$MANAGER_PORT,http://localhost:$MANAGER_PORT,http://127.0.0.1:$MANAGER_PORT
AUTH_SECURE_COOKIES=false
AUTH_SECRET=$(openssl rand -hex 32)
OPENCODE_SERVER_PORT=$OPENCODE_PORT
OPENCODE_HOST=127.0.0.1
PREVIEW_PORT=$PREVIEW_PORT
DATABASE_PATH=$S/data/db/opencode-manager.db
WORKSPACE_PATH=$W
XDG_CACHE_HOME=$S/data/xdg/cache
TMPDIR=$S/tmp/
OPENCODE_DISABLE_AUTOUPDATE=1
OPENCODE_DISABLE_CLAUDE_CODE=1
OCM_LEARNINGS_ENTRIES_PATH=$W/.opencode/learnings/entries
OPENCODE_BIN=$S/opencode/$OC2_VERSION/opencode
OPENCODE_SERVICE_CHANNEL=ocm-pool
OCM_CLAUDE_PROXY_URL=http://127.0.0.1:$CLIPROXY_PORT
OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE=$S/cliproxy/package/keys/management.key
OCM_CLAUDE_INFERENCE_KEY_FILE=$S/cliproxy/package/keys/ingress.key
OCM_CLAUDE_PROXY_API_KEY_FILE=$S/cliproxy/package/keys/upstream.key
OCM_CLAUDE_PROXY_GATE_DIRECTORY=$S/cliproxy/package/gate
OCM_CLAUDE_INFERENCE_UPSTREAM_URL=http://127.0.0.1:$HEADROOM_PORT
OCM_MAINTENANCE_MARKER=$S/run/maintenance.closed
EOF
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" python3 - >> $S/env/staging.env <<'PY'
import os, shlex
for key in ("ADMIN_EMAIL", "ADMIN_PASSWORD"):
    print(f"{key}={shlex.quote(os.environ[key])}")
PY
unset ADMIN_PASSWORD
chmod 600 $S/env/staging.env
fi
```

완료 확인(비밀값은 출력하지 않음): `grep -c '^ADMIN_PASSWORD=' $S/env/staging.env`가 `1`, `bash -n $S/env/staging.env && echo ok`가 `ok`.

- `ADMIN_EMAIL`과 `ADMIN_PASSWORD`는 셸 따옴표로 감싸 저장합니다. `launchd-backend.sh`가 이 파일을 셸로 읽기 때문에, 공백이나 `$` 같은 특수문자가 든 비밀번호를 따옴표 없이 쓰면 기동이 실패하거나 다른 값으로 읽힙니다.
- 관리자 계정은 Manager가 **처음 기동할 때 한 번만** 이 값으로 만듭니다. 그 뒤에 `ADMIN_PASSWORD`만 바꾸면 비밀번호는 바뀌지 않습니다. 비밀번호를 바꾸려면 8.6을 따릅니다.

- `OCM_MAINTENANCE_MARKER`: 이 파일이 **있으면** Manager가 새 작업 접수를 막습니다(외부 업그레이드용). 평소에는 파일을 만들지 않습니다.
- Cloudflare Tunnel로 외부 도메인을 쓸 때만 `AUTH_TRUSTED_ORIGINS`에 그 도메인을 추가합니다([8.7](#87-외부-도메인-로그인-cloudflare-tunnel)). 맥미니의 `opencode2.wineoflove.com`을 그대로 재사용하지 마세요.

### 8.2 백엔드 launchd 등록

번들에서 `bin/launchd-backend.sh`와 `$HOME/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist`가 이미 풀려 있습니다. plist는 `HOME=$S/home`, `ENVFILE=$S/env/staging.env`, `WorkingDirectory=$S/port`로 `bin/launchd-backend.sh`를 실행합니다. 이 스크립트는 Manager·OC2·preview 포트(4.6에서 이 Mac 값으로 바뀜)를 다른 프로세스가 쓰고 있으면 기동을 거부하고, `bun run backend/dist/index.js`를 실행합니다.

**[확인]** Manager 백엔드를 launchd에 등록하고 기동합니다.

```bash
chmod 700 $S/bin/*.sh
plutil -lint $U/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist
launchctl bootstrap gui/$(id -u) $U/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist
$S/bin/restart.sh && $S/bin/status.sh
curl -s http://127.0.0.1:$MANAGER_PORT/api/health | jq '{status, database, opencode, opencodeVersion, opencodeVersionSupported}'
# opencodeVersion이 $OC2_VERSION, opencodeVersionSupported: true
tail -50 $S/run/backend.log
```

### 8.3 CLIProxy 계정 로그인

**[직접]**
1. 브라우저에서 `http://<새맥IP>:<MANAGER_PORT>`에 접속해 관리자 계정으로 로그인합니다. 로그인되지 않으면 [8.6](#86-관리자-비밀번호-재설정)을 봅니다.
2. **설정 → Providers → 프록시 계정**에서 Claude와 OpenAI 계정을 추가합니다. OAuth 페이지에서 로그인한 뒤 리디렉션 URL을 붙여 넣습니다.
3. 완료 확인: 계정 수가 추가한 계정 수와 같아야 합니다.

   ```bash
   curl -s -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/management.key)" \
     http://127.0.0.1:$CLIPROXY_PORT/v8/management/credentials | jq '.files | length'
   ```

> 맥미니의 `auths/`는 복사하지 마세요. 같은 refresh token을 두 프록시가 함께 쓰면 토큰이 회전될 때 한쪽이 로그아웃될 수 있습니다. 이 Mac에서 따로 로그인하는 방식이 안전합니다.

### 8.4 추론 경로 확인

Assistant에서 새 세션을 열고 `openai/gpt-6.1-sol`과 `anthropic/claude-opus-5-5`에 각각 짧은 메시지를 보내 응답이 오는지 확인합니다. 응답이 없으면 계층별로 나눠서 확인합니다.

```bash
curl -s http://127.0.0.1:$HEADROOM_PORT/v1/models -H "Authorization: Bearer $(cat $S/cliproxy/package/keys/upstream.key)" | jq -r '.data[].id' | head
tail -30 $S/run/headroom/headroom.log; tail -30 $S/cliproxy/package/logs/stderr.log; tail -30 $S/run/backend.log
```

### 8.5 Manager에 GitHub 토큰 등록

[3](#3-github-토큰-새-mac-전용)에서 발급한 **이 Mac 전용 classic 토큰**을 등록합니다.

**[직접]**
1. **설정 → Git 설정 → Git 자격 증명 추가**
2. 이름 `github-<기기명>-<계정명>`, Host `github.com`, 유형 PAT, 토큰을 입력하고 기본 자격 증명으로 지정합니다.

완료 확인: Assistant 세션에서 3.2와 같은 검사를 실행합니다. 에이전트에게 "아래 명령을 실행하고 결과를 그대로 보여 줘"라고 요청해도 됩니다.

```bash
gh api user --jq .login                                                   # 3.2의 터미널 결과와 같은 계정
gh api repos/wineoflove/ocm-workspace-config --jq .permissions.push      # true
```

계정이 다르거나 `false`·`Not Found`이면 Manager에 등록한 토큰이 3.2와 다른 것입니다. Git 자격 증명의 토큰과 기본 지정을 다시 확인합니다.

에이전트 세션과 설정 백업 스케줄(10.4)은 이 토큰을 `GH_TOKEN`으로 받아 씁니다. 토큰이 만료되면 3.1에서 다시 발급해 3.2와 이 단계를 반복합니다.

### 8.6 관리자 비밀번호 재설정

관리자 계정이 이미 있으면 `staging.env`의 `ADMIN_PASSWORD`를 바꿔도 비밀번호가 바뀌지 않습니다. `ADMIN_PASSWORD_RESET=true`를 **한 번만** 켜고 재시작하면, Manager가 기동할 때 관리자 비밀번호를 `ADMIN_PASSWORD` 값으로 바꿉니다.

- 재설정할 때 그 관리자 계정의 **모든 로그인 세션이 종료**되고, 그 세션들의 푸시 알림 구독도 지워집니다. 모든 브라우저와 기기에서 다시 로그인해야 합니다.
- 플래그를 켜 둔 채로 두면 재시작할 때마다 다시 재설정되고 세션이 끊깁니다. 로그인을 확인한 뒤 반드시 플래그를 지웁니다.
- 백엔드 재시작은 실행 중인 세션을 중단하므로, 활성 세션이 없을 때 진행합니다.

**[직접] [확인]** 새 비밀번호를 입력하고 플래그를 켠 뒤 재시작합니다.

```bash
read -rs "NEWPW?새 관리자 비밀번호: "; echo
NEWPW="$NEWPW" ENVF=$S/env/staging.env python3 - <<'EOF'
import os, shlex
path = os.environ["ENVF"]
lines = [l for l in open(path).read().splitlines() if not l.startswith(("ADMIN_PASSWORD=", "ADMIN_PASSWORD_RESET="))]
lines += [f"ADMIN_PASSWORD={shlex.quote(os.environ['NEWPW'])}", "ADMIN_PASSWORD_RESET=true"]
open(path, "w").write("\n".join(lines) + "\n")
EOF
unset NEWPW; chmod 600 $S/env/staging.env
$S/bin/restart.sh
grep -E 'Admin password reset from environment|No credential account found' $S/run/backend.log | tail -1
```

- `Admin password reset from environment for <이메일>`이 보이면 재설정된 것입니다.
- `No credential account found`이면 그 이메일 계정에 비밀번호 로그인이 없습니다. `ADMIN_EMAIL`이 실제 관리자 이메일과 같은지 확인합니다.
- 아무것도 없으면 `ADMIN_EMAIL`의 계정이 아직 없는 것입니다. 이 경우 첫 기동에서 계정이 새로 만들어집니다(`Admin user created from environment`).

**[직접]** `http://127.0.0.1:<MANAGER_PORT>`에서 새 비밀번호로 로그인되는지 확인합니다. 그다음 플래그를 지우고 다시 재시작합니다.

```bash
ENVF=$S/env/staging.env python3 -c 'import os
p = os.environ["ENVF"]
lines = [l for l in open(p).read().splitlines() if not l.startswith("ADMIN_PASSWORD_RESET=")]
open(p, "w").write("\n".join(lines) + "\n")'
grep -c '^ADMIN_PASSWORD_RESET=' $S/env/staging.env      # 0
$S/bin/restart.sh
```

### 8.7 외부 도메인 로그인 (Cloudflare Tunnel)

외부 주소에서 로그인하려면 그 주소를 `AUTH_TRUSTED_ORIGINS`에 **정확히** 넣어야 합니다. 목록에 없는 주소에서 로그인하면 Manager가 `403 Invalid origin`으로 거부합니다.

- 형식: `https://` + 도메인. 기본 포트가 아니면 `:포트`까지 붙입니다. 끝에 `/`나 경로를 붙이지 않습니다. `www` 유무와 `http`/`https`도 브라우저 주소창과 같아야 합니다.
- 목록의 **첫 항목**이 인증 기준 주소(baseURL)로 쓰입니다. 맥미니처럼 외부 주소를 맨 앞에 둡니다.
- `AUTH_SECURE_COOKIES=false`는 그대로 둡니다. `true`로 바꾸면 쿠키에 Secure가 붙어, `http://`인 로컬·LAN 주소에서는 로그인이 유지되지 않습니다. 외부 `https://` 주소는 `false`여도 로그인됩니다(맥미니와 같은 구성).

예(외부 주소 `https://ocm.example.com`, LAN IP `192.168.0.10`, Manager 포트 5106):

```text
AUTH_TRUSTED_ORIGINS=https://ocm.example.com,http://192.168.0.10:5106,http://localhost:5106,http://127.0.0.1:5106
```

**[확인]** `staging.env`의 줄을 바꾸고 재시작합니다(활성 세션이 없을 때).

```bash
DOMAIN=https://ocm.example.com      # 외부 주소로 바꾸기
IP=${IP:-$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)}
if [ -z "$IP" ]; then echo "LAN IP를 찾지 못했습니다. IP=<이 Mac의 IP>로 지정한 뒤 다시 실행하세요." >&2; else
LINE="AUTH_TRUSTED_ORIGINS=$DOMAIN,http://$IP:$MANAGER_PORT,http://localhost:$MANAGER_PORT,http://127.0.0.1:$MANAGER_PORT"
LINE="$LINE" ENVF=$S/env/staging.env python3 -c 'import os
p = os.environ["ENVF"]
lines = [os.environ["LINE"] if l.startswith("AUTH_TRUSTED_ORIGINS=") else l for l in open(p).read().splitlines()]
open(p, "w").write("\n".join(lines) + "\n")'
grep '^AUTH_TRUSTED_ORIGINS=' $S/env/staging.env
$S/bin/restart.sh
fi
```

주소마다 Manager가 허용하는지 확인합니다. 없는 계정으로 로그인을 시도해 응답 코드만 봅니다. 실제 계정에는 영향이 없습니다.

```bash
for o in "$DOMAIN" "http://$IP:$MANAGER_PORT" "http://127.0.0.1:$MANAGER_PORT"; do
  printf '%-40s ' "$o"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$MANAGER_PORT/api/auth/sign-in/email" \
    -H "Origin: $o" -H 'Content-Type: application/json' \
    -d '{"email":"origin-check@example.invalid","password":"not-a-real-password"}'
done
```

| 응답 | 뜻 |
| --- | --- |
| `401` | 허용된 주소입니다(없는 계정이라 로그인만 실패) |
| `403` | 목록에 없는 주소입니다(`INVALID_ORIGIN`). 철자·`https`·포트·끝의 `/`를 확인합니다 |
| `429` | 짧은 시간에 로그인을 여러 번 시도해 걸린 제한입니다. 1분쯤 기다렸다가 다시 확인합니다 |

**[직접]** 그다음 주소마다 실제로 로그인합니다. 로그인한 뒤 새로고침해도 로그인 상태가 유지되어야 합니다.
1. 이 Mac에서 `http://127.0.0.1:<MANAGER_PORT>`
2. 같은 네트워크의 다른 기기에서 `http://<새맥IP>:<MANAGER_PORT>`
3. 외부에서 `https://<도메인>`

외부 주소에서 페이지가 아예 열리지 않거나 `502`가 나오면 Manager가 아니라 터널 문제입니다. cloudflared 설정의 서비스 주소가 `http://localhost:<MANAGER_PORT>`인지 확인합니다(`cloudflare-tunnel-routing` 스킬 참고).

---

## 9. 리포지토리 등록과 스킬 확인 (범위 1·4)

### 9.1 Manager에 리포지토리 등록

이후 업데이트 작업을 Manager 세션에서 하려면 두 소스 체크아웃을 로컬 리포지토리로 등록합니다. UI의 **리포지토리 추가 → 로컬 폴더**를 쓰거나, Assistant에게 다음과 같이 요청합니다(`<S>`는 이 Mac의 `$S` 값).

> `ocm` request로 `POST /repos`에 `{ "localPath": "<S>/port" }`와 `{ "localPath": "<S>/data/workspace/repos/oc2-custom" }`를 등록하고, 이름을 각각 "OCM for OC2", "OC2 custom"으로 바꿔 줘.

`assistant`(repo 0)는 Manager가 자동으로 만듭니다. 다른 프로젝트(릴톡 마케팅, 통합 예약 시스템 등)는 필요할 때 UI에서 Git URL로 clone합니다. 비공개 저장소는 8.5의 토큰으로 접근합니다.

### 9.2 스킬·에이전트·MCP 확인

Assistant 세션에서 다음을 확인합니다.

- 스킬 목록에 전역 38개가 보이는지 확인합니다: `ast-grep`, `better-*` 7종, `cloudflare-tunnel-routing`, `comment-checker`, `deep-research`, `dependency-auditor`, `docx`, `gh-issues`, `github`, `hallmark-marketing`, `impeccable-review`, `indirect-prompt-injection`, `lsp`, `mcp-builder`, `mcp-dependency-review`, `mcporter`, `pdf`, `pptx`, `receiving-code-review`, `self-improvement`, `senior-architect`, `setup-writing-style`, `skill-creator`, `skill-security-auditor`, `skill-validation`, `tmux`, `typescript`, `ui-automation`, `ultrawork`, `webapp-testing`, `xlsx`.
- Manager 생성 스킬 5개(`repo-management`, `schedule-management`, `notifications`, `manager-settings`, `session-management`)가 보이는지 확인합니다.
- subagent 목록에 `explorer`, `librarian`, `oracle`, `metis`, `momus`, `reviewer`, `looker`, `junior-*`가 있는지 확인합니다.
- MCP 8개가 모두 connected인지 확인합니다. 설정 화면이나 세션의 도구 목록에서 볼 수 있습니다.
- `ocm` 도구의 `learning_search`로 학습 저장소가 검색되는지 확인합니다. `sourceRoot`가 `$W/.opencode/learnings/entries`여야 합니다.

---

## 10. 학습·점검 스케줄 (범위 3)

Manager DB는 새로 만들어졌으므로 **스케줄 ID와 보고 세션 ID가 맥미니와 다릅니다.** 스케줄 프롬프트, `schedule-reports.json`, `review-config.json`이 이 ID들을 참조하기 때문에 모두 새 값으로 바꿔야 합니다. 스케줄 정의는 `$S/run/new-mac-meta/schedules.json`에 있으며, 경로는 4.5에서 이미 이 Mac 기준으로 바뀌었습니다.

| 맥미니 ID | 이름 | cron (Asia/Seoul) | 이 Mac에서 |
| --- | --- | --- | --- |
| 5 | 학습 일일 리뷰 | `0 3 * * *` | **필수** |
| 6 | 학습 주간 리뷰 | `0 4 * * 1` | **필수** |
| 7 | 핵심 4종 일일 버전 점검 (OC2·OCM·Headroom·CLIProxy) | `0 6 * * *` | 선택 |
| 9 | 개발환경·MCP·스킬 주간 버전 점검 (Claude·Codex 포함) | `0 6 * * 1` | 선택 |
| 2 | workspace-config-backup | `0 5 * * *` | 선택. 브랜치를 바꿔야 함([10.4](#104-선택-설정-백업-스케줄)) |

스케줄 정의(이름·cron·모델·프롬프트)는 번들을 만든 시점의 맥미니 설정입니다. 맥미니에서 스케줄을 바꾸면 [12.6](#126-설치-기준-갱신-맥미니)을 실행해야 새 설치에 반영됩니다.

먼저 선택 작업 중 무엇을 등록할지 정합니다. 이후 단계(보고 세션 만들기, ID 연결, `schedule-reports.json`)는 **등록하는 작업에만** 적용합니다.

### 10.1 보고 세션 만들기

Assistant 디렉터리(`$W/repos/assistant`)에 보고용 세션을 만들고 ID를 기록합니다. UI에서 새 세션을 만들어도 되고, Assistant에게 `ocm` request `POST /sessions`로 만들어 달라고 해도 됩니다. 등록하지 않는 선택 작업의 보고 세션은 만들지 않습니다.

| 용도 | 예시 제목 | 필요 여부 | 들어갈 곳 |
| --- | --- | --- | --- |
| 학습 일일·주간 리뷰 보고 | `학습 리뷰 보고` | 필수 | `review-config.json`의 `feedbackSession`, `schedule-reports.json`의 학습 작업 2개 |
| 핵심 4종 일일 버전 점검 | `일일 버전 점검 보고` | 그 작업을 등록할 때만 | `schedule-reports.json` |
| 주간 버전 점검 | `주간 버전 점검 보고` | 그 작업을 등록할 때만 | `schedule-reports.json` |
| 설정 백업 | `설정 백업 보고` | 그 작업을 등록할 때만 | `schedule-reports.json` |

### 10.2 스케줄 등록

Assistant 세션에 다음 요청을 보냅니다(`<S>`는 이 Mac의 `$S` 값).

> `<S>/run/new-mac-meta/schedules.json`에서 다음 작업만 repo 0(Assistant)에 등록해 줘: `학습 일일 리뷰`, `학습 주간 리뷰`, 그리고 `<선택한 작업 이름들, 없으면 없음>`. 목록에 없는 작업은 등록하지 마. `schedule-management` 스킬을 쓰고 각 항목의 `name`, `description`, `enabled`, `scheduleMode`, `cronExpression`, `timezone`, `agentSlug`, `model`, `workspaceMode`, `permissionConfig`(JSON 문자열을 객체로 파싱), `prompt`를 그대로 사용해. `workspace-config-backup`을 등록한다면 10.4를 적용한 뒤 등록해. 등록한 작업만 맥미니 ID → 새 ID 대응표를 만들고, 그 프롬프트의 `--job <맥미니 ID>`와 `schedule-reports/job-<맥미니 ID>`를 새 ID로 PATCH해 줘. `repos/assistant/.opencode/schedule-reports.json`의 `jobs`는 등록한 작업만 새 ID와 내가 준 보고 세션 ID로 다시 쓰고, 등록하지 않은 작업 항목은 지워 줘. `.opencode/learnings/review-config.json`의 `feedbackSession`과 `cleanupJobIds`(학습 일일·주간의 새 ID)도 바꿔 줘. 마지막으로 `GET /repos/0/schedules`로 다시 읽어 등록 목록이 요청과 정확히 같은지 대조해 줘.

등록이 끝나면 학습 일일 리뷰를 한 번 수동으로 실행해(`POST /repos/0/schedules/<새 ID>/run`) 다음을 확인합니다.

- 실행이 `completed`로 끝나는지
- 최종 응답에 `report_outcome`이 한 번 호출됐는지
- 학습 리뷰 보고 세션에 보고서가 게시됐는지

바뀐 두 설정 파일은 전용 브랜치에서 추적하는 파일입니다. 바로 커밋해 원격에 올립니다. 백업 스케줄을 켰다면 그 첫 실행이 대신 올리지만, 그 전까지는 로컬에만 남습니다.

```bash
GW=(git --git-dir=$G --work-tree=$W)
"${GW[@]}" status --short -- repos/assistant/.opencode/schedule-reports.json .opencode/learnings/review-config.json
"${GW[@]}" add --update -- repos/assistant/.opencode/schedule-reports.json .opencode/learnings/review-config.json
"${GW[@]}" commit -m "chore(config): $CONFIG_BRANCH schedule and report session IDs"
"${GW[@]}" push origin "$CONFIG_BRANCH"
```

첫 실행은 새 DB에 분석할 대화가 거의 없으므로 결과가 짧은 것이 정상입니다. 학습 반영 검증 스크립트(`scripts/learning-review/verification-command.mjs`)는 macOS 계정 정보에서 실제 HOME을 찾으므로 사용자명이 달라도 `~/.local/bin`의 `bun`·`pnpm`·`ruff`를 사용합니다.

### 10.3 두 대를 함께 운영할 때

- 학습 저장소(`$W/.opencode/learnings`)와 `assistant.md`는 Mac마다 따로 갱신됩니다. 학습 리뷰가 양쪽에서 돌면 기록과 지침이 서로 달라질 수 있습니다. 한쪽만 기준으로 삼으려면 다른 쪽의 학습 스케줄을 끄거나, [12.5](#125-워크스페이스-설정스킬) 방식으로 맥미니 변경을 가끔 가져오세요. 무엇을 가져올지는 사람이 직접 판단합니다.
- 설정 백업은 Mac마다 **다른 브랜치**에 push합니다. 맥미니는 `macmini`, 이 Mac은 `$CONFIG_BRANCH`(기기명-계정명)를 쓰며, `main`은 기존 Linux 서버용이라 건드리지 않습니다.
- GitHub 토큰, CLIProxy 키·로그인, API 키는 기기마다 따로입니다. 한 대를 정리할 때는 그 기기의 토큰과 키만 폐기합니다.

### 10.4 (선택) 설정 백업 스케줄

`workspace-config-backup` 프롬프트는 `macmini` 브랜치를 쓰도록 되어 있습니다. 등록하기 전에 스케줄 정의 파일의 이 프롬프트만 이 Mac 브랜치용으로 바꿉니다.

```bash
CONFIG_BRANCH="$CONFIG_BRANCH" F=$S/run/new-mac-meta/schedules.json python3 - <<'EOF'
import json, os, re
path, branch = os.environ["F"], os.environ["CONFIG_BRANCH"]
jobs = json.load(open(path))
job = next(j for j in jobs if j["name"] == "workspace-config-backup")
prompt = job["prompt"].replace("맥미니의 워크스페이스 설정", "이 Mac의 워크스페이스 설정")
token = r"(?<![A-Za-z0-9_-])macmini(?![A-Za-z0-9_-])"   # 한글 조사(macmini와 등)가 붙어도 치환
prompt = re.sub(token, branch, prompt)
assert not re.search(token, prompt), "macmini가 남았습니다. 직접 확인하세요."
prompt = prompt.replace("기존 Linux 서버의 main 브랜치는 변경하지 않습니다.",
                        "기존 Linux 서버의 main 브랜치와 다른 기기의 브랜치(macmini 등)는 변경하지 않습니다.")
assert "macmini 등" in prompt and f"push -u origin {branch}" in prompt \
    and f"refs/heads/{branch}" in prompt, "prompt changed shape; edit by hand"
job["prompt"], job["description"] = prompt, f"{branch} 브랜치로 워크스페이스 설정 백업"
json.dump(jobs, open(path, "w"), ensure_ascii=False, indent=2)
print(f"workspace-config-backup → {branch}")
EOF
```

바뀐 프롬프트는 `refs/heads/$CONFIG_BRANCH`를 확인하고 `push -u origin $CONFIG_BRANCH`로 push합니다. 4.7에서 원격 브랜치를 이미 만들었으므로, 첫 실행부터 "원격 브랜치가 로컬 브랜치의 조상인지" 검사를 정상적으로 통과합니다.

git dir과 작업 트리 경로(`--git-dir=<HOME>/apps/ocm-workspace-config.git --work-tree=…`)는 4.5에서 이미 이 Mac 기준으로 바뀌었습니다. push에 쓰는 `GH_TOKEN`은 Manager에서 받으므로 8.5에 등록한 이 Mac의 토큰이 사용됩니다.

이 프롬프트로 10.2에서 등록하고, 보고 세션을 `schedule-reports.json`에 연결한 뒤 그 파일 변경을 커밋합니다. 그다음 두 단계를 **따로** 확인합니다.

1. **활성화**(등록 직후): Assistant에게 "`GET /repos/0/schedules/<새 ID>`로 `enabled`와 `nextRunAt`을 KST로 보여 줘"라고 요청합니다. `enabled: true`이고 `nextRunAt`이 다음 05:00(KST)이면 완료입니다.
2. **첫 실행과 원격 반영**(첫 실행 뒤): 다음 05:00을 기다리거나 `POST /repos/0/schedules/<새 ID>/run`으로 한 번 실행합니다.
   - 실행이 `completed`이고, `report_outcome`이 `succeeded`이며, 최종 응답 마지막 줄이 `WORKSPACE_BACKUP_RESULT_V1=verified`인지 봅니다.
   - 터미널에서 원격과 로컬이 같은지, 백업 대상에 남은 변경이 없는지 확인합니다.

   ```bash
   git --git-dir=$G fetch -q origin
   [ "$(git --git-dir=$G rev-parse HEAD)" = "$(git --git-dir=$G rev-parse "origin/$CONFIG_BRANCH")" ] \
     && echo "로컬 = 원격" || echo "로컬과 원격이 다릅니다"
   git --git-dir=$G --work-tree=$W status --short -- .config/opencode repos/assistant .opencode/learnings | head
   ```

1번만 확인한 상태에서는 "백업 활성화됨, 첫 실행 미확인"으로 기록합니다.

---

## 11. 최종 점검

설치 상태(등록·설정이 되어 있음)와 실제 동작(그 상태로 돌아가는 것을 확인함)을 따로 체크합니다. 재부팅을 미뤘거나 첫 백업을 기다리는 중이면 해당 칸을 비워 두고 "미확인"으로 기록합니다.

```bash
$S/bin/status.sh
for l in io.wineoflove.ocm2.backend com.aion.ocm.claude-proxy io.wineoflove.ocm2.headroom \
         io.wineoflove.mcp.context7 io.wineoflove.mcp.firecrawl io.wineoflove.mcp.markitdown io.wineoflove.mcp.exa; do
  printf '%-30s ' $l
  launchctl print gui/$(id -u)/$l 2>/dev/null | awk '/^\tstate = /{s=$3} /^\tpid = /{p=$3} END{print (s ? s : "미등록") (p ? " (pid " p ")" : "")}'
done
bash $S/port/deploy/new-mac/check-ports.sh $S/env/ports.env
curl -s http://127.0.0.1:$MANAGER_PORT/api/health | jq -r '.status + " " + .opencodeVersion'
curl -s http://127.0.0.1:$HEADROOM_PORT/health | jq -r '.status + " " + .version'
jq -r '.mcp.servers | keys | length' $W/.config/opencode/opencode.jsonc                # 8
git -C $S/port remote -v; git -C $W/repos/oc2-custom remote -v
git --git-dir=$G fetch -q origin; git --git-dir=$G status -sb | head -1               # ## <브랜치>...origin/<브랜치> (ahead/behind 없음)
git --git-dir=$G --work-tree=$W status --short | head                                  # 출력 없음
grep -rlI "$(jq -r .sourceHome $S/run/new-mac-meta/manifest.json)" $S/bin $U/apps/mcp-shared/bin $W/.config/opencode $U/Library/LaunchAgents 2>/dev/null   # 사용자명이 다르면 출력 없음
```

| 항목 | 설치 상태 | 실제 동작 |
| --- | --- | --- |
| launchd 서비스 7개 | [ ] 모두 등록되어 `running` | [ ] 재부팅·로그인 후 다시 실행해도 모두 `running` |
| 포트 9개 | [ ] `check-ports.sh`에서 모두 OC2 서비스가 대기 중 | — |
| Manager | [ ] `/api/health`가 `healthy`, `opencodeVersion`이 `$OC2_VERSION` | [ ] 로컬·LAN(·외부) 주소에서 로그인되고 새로고침 후에도 유지(8.7) |
| 추론 | [ ] 프록시 계정 등록(8.3) | [ ] Assistant에서 OpenAI·Anthropic 모델이 각각 응답(8.4) |
| MCP | [ ] `opencode.jsonc`에 8개 등록 | [ ] Assistant에서 8개 모두 connected |
| 스킬·에이전트 | [ ] 전역 38 + Manager 생성 5 파일 존재 | [ ] Assistant 스킬 목록에 43개, subagent 목록 표시 |
| GitHub | [ ] 터미널(3.2)과 Manager(8.5)에 같은 토큰 등록 | [ ] 두 곳의 `gh api user --jq .login` 결과가 같고 `permissions.push`가 `true` |
| 저장소 | [ ] `port`·`oc2-custom`의 origin·upstream 연결 | — |
| 설정 브랜치 | [ ] 로컬 HEAD와 `origin/<브랜치>`가 같음 | [ ] 미커밋 변경 없음(`status --short` 출력 없음) |
| 학습 스케줄 | [ ] 일일·주간 등록, `enabled`·`nextRunAt` 확인 | [ ] 수동 1회 실행 `completed`, 보고서 게시 |
| 설정 백업(선택) | [ ] 등록, `enabled`·`nextRunAt` 확인(10.4-1) | [ ] 첫 실행 성공, 로컬 = 원격(10.4-2) |
| UI 자동화(선택) | [ ] LSP·agent-browser·agent-desktop 버전 출력 | [ ] LSP `initialize ok`, cua-driver 권한 2개 true·UI 읽기·PNG 캡처(7.6) |

---

## 12. 업데이트 절차

일일·주간 버전 점검 스케줄이 새 버전 유무를 알려 줍니다. 실제 업데이트는 영호 님이 승인한 뒤 진행합니다. 실행 중인 세션을 끊지 않도록 **활성 세션이 0일 때** 진행하고, 백업과 롤백 경로를 먼저 확보합니다. Assistant에게 "OC2/CLIProxy 업데이트 해 줘"라고 요청하면 같은 단순 절차(사전 확인 → idle 대기 → 정지 → 백업 → 교체 → 기동 → 검증 → 실패 시 복구)를 외부 1회성 launchd 작업으로 진행합니다.

### 12.1 OCM (Manager)

```bash
cd $S/port
git status --short                       # 비어 있어야 함
git fetch origin && git merge --ff-only origin/main
env HOME=$S/home pnpm install --frozen-lockfile
$S/bin/build-oc2.sh                      # 운영 dist를 건드리지 않고 run/build-<시각>에 빌드
$S/bin/deploy-oc2-code.sh                # 활성 세션 0 확인 → dist 백업·교체 → 재시작 → 30초 안정화, 실패 시 롤백
```

upstream 변경을 포크에 반영할 때는 `git fetch upstream` 후 별도 브랜치에서 병합하고, 테스트(`pnpm test`, `pnpm typecheck`)를 거친 다음 `origin/main`에 push합니다.

### 12.2 OC2 native

1. 새 upstream 태그를 받습니다: `git -C $W/repos/oc2-custom fetch --no-tags upstream refs/tags/vX.Y.Z:refs/tags/vX.Y.Z`
2. 현재 포크 변경을 추출합니다: `git -C $W/repos/oc2-custom diff <현재 기반 upstream 태그> origin/main > $S/run/fork.patch`. `main` 트리는 기반 upstream 태그 + 포크 패치입니다. 기반 태그는 `main` 최신 커밋 메시지의 `Base: upstream vX.Y.Z`에서 확인합니다.
3. `vX.Y.Z`에서 worktree를 만들고 `git apply -3 $S/run/fork.patch`로 적용한 뒤 충돌을 해결합니다. 포크 관련 테스트(`packages/core/test/account-pool*`, `credential*`, `config/*` 등)와 `bun run check`를 실행합니다.
4. 커밋 `feat(ocm-pool): OC2 custom X.Y.Z-ocm-pool.<N+1>`을 만들고, 기존 `main`을 첫 부모로 하는 merge 커밋을 만들어 push합니다. 이렇게 하면 force push가 필요 없습니다. zsh에서는 `"${M}:refs/heads/main"`처럼 변수를 중괄호로 감싸야 `:r` 수정자로 해석되지 않습니다.

   ```bash
   M=$(git commit-tree <패치 커밋>^{tree} -p origin/main -p <패치 커밋> -m "merge: OC2 custom X.Y.Z-ocm-pool.<N+1> into main")
   git push origin "${M}:refs/heads/main"
   ```

5. [4.3 B](#43-oc2-커스텀-native)와 같은 방식으로 빌드합니다. `OPENCODE_VERSION`과 Bun 버전은 새 `packageManager`에 맞춥니다. 결과물은 `$S/opencode/X.Y.Z-ocm-pool.<N+1>/opencode`에 둡니다.
6. 새 Mac이 같은 바이너리를 받도록 하는 Release는, 전환이 끝난 뒤 맥미니에서 [12.6](#126-설치-기준-갱신-맥미니)을 실행하면 운영 바이너리로 자동으로 만들어집니다.

7. 전환은 외부 1회성 작업으로 진행합니다.
   - idle 대기
   - 백엔드 정지와 Manager·OC2 포트 해제 확인
   - native DB(`$W/.opencode/state/opencode/opencode-ocm-pool.db`와 `-wal`/`-shm`), Manager DB, `staging.env`를 SHA-256 검증과 함께 백업
   - `OPENCODE_BIN` 교체
   - 기동 후 `/api/health`의 `opencodeVersion` 확인
   - 실패 시 env와 DB를 복구하고 이전 버전으로 재기동

   새 버전에 native DB migration이 있으면 먼저 DB 사본에서 검증합니다.

### 12.3 CLIProxy

```bash
V=8.x.y
cd $S/downloads/cliproxy
curl -fLO https://github.com/router-for-me/CLIProxyAPI/releases/download/v$V/CLIProxyAPI_${V}_darwin_aarch64.tar.gz
# gh release view v$V -R router-for-me/CLIProxyAPI --json assets 의 digest와 대조 → tar xzf … cli-proxy-api → xattr 정리
launchctl bootout gui/$(id -u)/com.aion.ocm.claude-proxy
cp -p $S/cliproxy/package/bin/cli-proxy-api $S/run/cli-proxy-api.before-$V
cp cli-proxy-api $S/cliproxy/package/bin/cli-proxy-api && chmod 700 $S/cliproxy/package/bin/cli-proxy-api
launchctl bootstrap gui/$(id -u) $U/Library/LaunchAgents/com.aion.ocm.claude-proxy.plist
launchctl kickstart gui/$(id -u)/com.aion.ocm.claude-proxy
# x-cpa-version 헤더와 계정 수(.files | length)가 이전과 같은지 확인. 다르면 백업 바이너리로 되돌립니다.
```

### 12.4 Headroom

운영 venv를 직접 업그레이드하지 않습니다. 새 venv를 별도 경로에 만들고 검증한 뒤 plist의 `ProgramArguments.0`과 `ORT_DYLIB_PATH`만 바꿉니다.

```bash
NEW=$S/run/headroom-<버전>/.venv
uv venv --python 3.12 $NEW
uv pip install --python $NEW/bin/python 'headroom-ai[proxy]==<버전>'
$NEW/bin/python -m headroom.cli proxy --help >/dev/null
```

plist를 바꾼 뒤 `launchctl bootout`/`bootstrap`으로 재기동하고 `/health`의 버전을 확인합니다.

### 12.5 워크스페이스 설정·스킬

이 Mac은 전용 브랜치(`$CONFIG_BRANCH`)만 씁니다. `macmini` 브랜치는 맥미니 변경을 참고할 때 읽기만 합니다.

**이 Mac의 변경 백업**: 10.4 스케줄이 하거나 수동으로 합니다. `git --git-dir=$G --work-tree=$W add -- <파일…>`(추적 중인 파일은 `add --update -- <파일…>`) → `commit` → `push origin "$CONFIG_BRANCH"`. 경로 없이 쓰는 `add .`, `add -A`, `add -u`는 쓰지 않습니다.

**맥미니 변경 가져오기**: 맥미니 브랜치를 통째로 merge하지 않습니다. 경로와 포트가 달라 매번 충돌하기 때문입니다. 마지막으로 가져온 맥미니 커밋(`forkedFrom`) 이후에 바뀐 것만 골라 가져옵니다.

```bash
GW=(git --git-dir=$G --work-tree=$W)
BASE=$(git --git-dir=$G config "branch.$CONFIG_BRANCH.forkedFrom")
git --git-dir=$G fetch origin
git --git-dir=$G log --oneline "$BASE"..origin/macmini | head -20
git --git-dir=$G diff --stat "$BASE" origin/macmini | tail -5
```

1. **학습 기록**(`.opencode/learnings/entries`, `reviews`, `applications`): 파일명이 고유하고 추가만 되므로, 새로 생긴 파일을 그대로 가져옵니다.

   ```bash
   git --git-dir=$G diff --name-only -z --diff-filter=A "$BASE" origin/macmini -- .opencode/learnings \
     | xargs -0 -r "${GW[@]}" checkout origin/macmini --
   ```

2. **지침·설정 파일**(`.config/opencode`, `repos/assistant`): `git --git-dir=$G diff "$BASE" origin/macmini -- <경로>`로 내용을 보고, 필요한 파일만 `"${GW[@]}" checkout origin/macmini -- <파일…>`로 가져옵니다. 가져온 파일은 맥미니 기준이므로 두 스크립트를 다시 적용합니다.
   - 사용자명이 다르면: `bash $S/port/deploy/new-mac/relocate.sh <맥미니 HOME> <파일…>`
   - 포트가 다르면: `bash $S/port/deploy/new-mac/set-ports.sh --source $S/env/ports.env <파일…>`. `--source`는 지정한 파일만 맥미니 포트에서 이 Mac 포트로 바꿉니다.
   - 이 Mac에서 직접 고친 파일이면 덮어쓰기 전에 `"${GW[@]}" diff <파일>`로 이 Mac의 변경을 확인합니다.
3. 가져온 파일만 경로를 지정해 add합니다. `checkout`으로 가져온 파일은 이미 stage되어 있고, 스크립트로 다시 바꾼 파일은 `add --update -- <파일…>`로 넣습니다. 그다음 커밋하고 push한 뒤 기준을 갱신합니다.

   ```bash
   "${GW[@]}" commit -m "chore(config): sync from macmini $(git --git-dir=$G rev-parse --short origin/macmini)" \
     -m "Macmini-Base: $(git --git-dir=$G rev-parse origin/macmini)"
   "${GW[@]}" push origin "$CONFIG_BRANCH"
   git --git-dir=$G config "branch.$CONFIG_BRANCH.forkedFrom" "$(git --git-dir=$G rev-parse origin/macmini)"
   ```

일부 파일만 가져와도 기준은 그 시점의 `origin/macmini`로 갱신합니다. 가져오지 않기로 한 변경은 다음 비교에 다시 나타나지 않습니다.
- MCP 패키지는 `npm install --prefix $T/npm-mcp/<이름> --save-exact <패키지>@<버전>` 후 `launchctl kickstart -k gui/$(id -u)/io.wineoflove.mcp.<이름>`으로 갱신합니다.

### 12.6 설치 기준 갱신 (맥미니)

맥미니에서 OC2·CLIProxy·Headroom·OCM을 업그레이드했거나 운영 스크립트·`opencode.jsonc`·plist·스케줄을 바꿨다면, 맥미니에서 다음을 실행합니다. 이후 이 가이드를 받는 Mac은 그 시점의 맥미니 버전으로 설치됩니다. 이미 설치한 Mac은 바뀌지 않습니다.

```bash
S=/Users/<맥미니 사용자>/apps/ocm-v2-staging
git -C $S/port fetch -q origin
git -C $S/port show origin/main:deploy/new-mac/publish-baseline.sh > $S/tmp/publish-baseline.sh
bash $S/tmp/publish-baseline.sh; rm -f $S/tmp/publish-baseline.sh
```

스크립트는 실행할 때 `origin/main`을 새 임시 worktree로 꺼내 그 안의 `make-bundle.sh`를 쓰므로, 운영 체크아웃이 어느 커밋이든 항상 최신 절차로 동작합니다.

- `gh`가 두 포크 저장소에 push할 수 있는 계정으로 인증되어 있어야 합니다(`gh auth login` 또는 `GH_TOKEN`). 인증이 없으면 아무것도 바꾸지 않고 멈춥니다.
- 맥미니의 일반 터미널에는 현재 `gh` 로그인이 없습니다. 터미널에서 직접 돌리려면 한 번 `gh auth login`을 하거나, Assistant에게 "12.6을 실행해 줘"라고 요청합니다. Assistant 세션은 Manager에 등록된 토큰을 씁니다.
- 실패하면 임시 worktree를 지우고 끝나며, 중간 결과는 push하지 않습니다.

`publish-baseline.sh`가 하는 일:
1. `origin/main`의 임시 worktree에서 `make-bundle.sh`로 번들과 `versions.env`를 다시 만듭니다. 운영 체크아웃(`port`)과 실행 중인 서비스는 건드리지 않습니다.
2. 실행 중인 CLIProxy가 그 버전의 공식 Release 바이너리와 같은지 해시로 확인합니다. 다르면 멈춥니다.
3. 실행 중인 OC2 버전의 Release가 `yeongho_opencode2`에 없으면 운영 바이너리로 Release를 만듭니다. 이미 있으면 Release의 바이너리 해시가 운영 바이너리와 같은지 확인합니다.
4. 내용이 바뀐 경우에만 `deploy/new-mac`을 커밋해 `origin/main`에 push합니다. 바뀐 것이 없으면 아무것도 올리지 않습니다.

함께 챙길 것:
- **OCM 코드**: 새 Mac은 `origin/main`을 빌드합니다. 맥미니에서 고친 코드가 커밋되지 않았으면 새 Mac에는 빠집니다. 스크립트가 `port`에 커밋되지 않은 소스 변경이 있으면 경고합니다.
- **OC2 소스**: 바이너리(A 방식)는 Release로 따라가지만, 소스 빌드(B 방식)는 `yeongho_opencode2`의 소스가 있어야 합니다. 새 버전을 올렸다면 12.2의 1~4단계로 소스를 push한 뒤 실행합니다. Release가 소스보다 먼저 만들어지면 Release 설명에 그 사실이 적힙니다.
- **지침·스킬·학습**: 이 스크립트가 아니라 매일 05:00 설정 백업(`macmini` 브랜치)으로 따라갑니다.

`make-bundle.sh`는 파일을 읽기만 하고, 묶을 파일에서 비밀값이 발견되면 중단합니다. 맥미니의 실제 포트와 버전은 `staging.env`, `opencode.jsonc`, plist, 실행 파일에서 읽어 `manifest.json`과 `versions.env`에 기록합니다. **이 저장소와 `yeongho_opencode2`는 공개 저장소입니다.** 번들에 새 파일을 추가할 때는 비밀값이나 개인 정보가 들어가지 않는지 먼저 확인하세요.

### 12.7 설치 후 포트 바꾸기

이미 운영 중인 Mac에서 포트를 바꿀 때도 같은 스크립트를 씁니다. 서비스를 다시 띄워야 하므로 **활성 세션이 0일 때** 진행합니다.

1. `$S/env/ports.env`에서 값을 고치고 `set -a; . $S/env/ports.env; set +a`로 다시 불러옵니다.
2. 파일에 적용합니다: `bash $S/port/deploy/new-mac/set-ports.sh $S/env/ports.env`. 직전에 적용한 값(`ports.applied.env`)을 기준으로, 바뀐 포트만 변환합니다.
3. 스크립트 밖에서 관리하는 곳을 고칩니다.
   - Manager·OC2·preview·CLIProxy·Headroom 포트: `$S/env/staging.env`의 `PORT`, `CORS_ORIGIN`, `AUTH_TRUSTED_ORIGINS`, `OPENCODE_SERVER_PORT`, `PREVIEW_PORT`, `OCM_CLAUDE_PROXY_URL`, `OCM_CLAUDE_INFERENCE_UPSTREAM_URL`
   - CLIProxy 포트: `$S/cliproxy/package/config.yaml`의 `server.port`
   - MCP 포트: `python3 $U/apps/mcp-shared/bin/write-plists.py`로 plist를 다시 생성
4. 바뀐 서비스만 다시 띄웁니다. 한 대씩 확인하며 진행합니다.
   - MCP: `launchctl bootout gui/$(id -u)/io.wineoflove.mcp.<이름>` → `launchctl bootstrap gui/$(id -u) $U/Library/LaunchAgents/io.wineoflove.mcp.<이름>.plist`
   - CLIProxy: `launchctl kickstart -k gui/$(id -u)/com.aion.ocm.claude-proxy`
   - Headroom: plist를 바꿨으므로 `bootout` 후 `bootstrap`
   - Manager: `$S/bin/restart.sh`
5. [11](#11-최종-점검)의 점검을 다시 실행합니다. 브라우저 접속 주소와, Cloudflare Tunnel을 쓴다면 그 설정의 포트도 바꿉니다.

---

## 13. 문제 해결

| 증상 | 확인할 곳 |
| --- | --- |
| 백엔드가 계속 재시작됨 | `$S/run/backend.log`. "port … held by pid"이면 다른 프로세스가 Manager·OC2·preview 포트를 쓰고 있습니다. 다른 포트로 바꾸려면 4.6을 다시 적용합니다. 그 프로세스를 직접 확인하고, 이름 패턴으로 일괄 종료하지 마세요 |
| 관리자 비밀번호로 로그인되지 않음 | 계정이 이미 있으면 `ADMIN_PASSWORD`를 바꿔도 반영되지 않습니다. [8.6](#86-관리자-비밀번호-재설정)의 `ADMIN_PASSWORD_RESET=true`를 한 번 적용합니다. 비밀번호에 공백·특수문자가 있으면 `staging.env`에서 따옴표로 감싸졌는지 봅니다(`bash -n $S/env/staging.env`) |
| 로그인 직후 다시 로그인 화면으로 돌아감 | `http://` 주소에서 `AUTH_SECURE_COOKIES=true`이면 쿠키가 저장되지 않습니다. `false`로 둡니다. `ADMIN_PASSWORD_RESET=true`를 켜 둔 채 재시작하면 매번 세션이 지워집니다(8.6) |
| 외부 주소에서만 로그인 실패, `403 Invalid origin` | `AUTH_TRUSTED_ORIGINS`에 `https://`를 포함한 정확한 주소가 있는지 봅니다. 8.7의 `curl` 검사에서 `401`이 나와야 합니다 |
| 4.4 확인에서 종료 코드 `128` | 인증·네트워크 오류입니다. 신규 설치로 진행하지 말고 3.2의 완료 확인(`gh api user`, `permissions.push`)부터 다시 봅니다 |
| `opencodeVersionSupported: false` 또는 OC2 포트가 대기하지 않음 | `OPENCODE_BIN` 경로·실행 권한·quarantine 속성, `opencode --version` |
| `relocate.sh`가 exit 1 | 출력된 파일에 남은 맥미니 경로를 직접 확인. 다른 계정 경로(`/Users/<이름>x`)나 문장 끝에 마침표가 붙은 경로는 일부러 바꾸지 않습니다 |
| Anthropic 모델만 실패 | `OCM_CLAUDE_INFERENCE_*` 키 경로, Headroom 포트 상태, CLIProxy Claude 계정 |
| OpenAI 모델만 실패 | `opencode.jsonc`의 `upstream.key` 경로, Headroom → CLIProxy 포트, Codex 계정 |
| MCP가 disconnected | `$HOME/apps/mcp-shared/logs/<이름>.log`, 키 파일 권한(600), `node $HOME/apps/mcp-shared/bin/smoke.mjs` |
| codegraph만 disconnected | `$HOME/.codegraph/current/bin/codegraph version`, `opencode.jsonc`의 codegraph `command` 경로 |
| Playwright MCP 실패 | 토큰 파일 권한(0600, 심볼릭 링크 불가), Chrome 확장 설치 프로필과 wrapper의 `--user-data-dir`·`--profile-dir-name`(7.2의 `chrome://version` 프로필 경로) |
| cua-driver가 `screen_locked` 또는 `direct_capture_consent_required` | 화면 잠금을 풀거나, macOS의 직접 캡처 허용 창을 승인한 뒤 7.6의 확인을 다시 실행합니다 |
| `gh`·`git push` 인증 실패, 비공개 저장소가 `Repository not found` | 터미널은 `gh auth status`, 에이전트 세션은 Manager Git 자격 증명(8.5). 다음을 확인합니다. classic 토큰인지(`ghp_`), scope `repo`가 있는지, 만료되지 않았는지, 이 계정이 그 저장소의 collaborator 초대를 수락했는지(3.0). fine-grained 토큰(`github_pat_`)은 collaborator 저장소에 접근할 수 없습니다 |
| 스케줄이 `JOB_NOT_CONFIGURED` / `SELF_RUN_NOT_FOUND` | `schedule-reports.json`의 job ID·보고 세션 ID가 새 값인지 확인 |
| 학습 리뷰 게시 실패 | `review-config.json`의 `feedbackSession`이 존재하는 세션인지 확인 |
| 세션 생성이 FOREIGN KEY 오류로 실패 | `data/workspace` 안에 `.git`이 생겼는지 확인. 워크스페이스 설정 git dir은 반드시 밖(`$HOME/apps/ocm-workspace-config.git`)에 둡니다 |

운영 규칙은 맥미니와 같습니다.

- 대화 세션 안에서 Manager·CLIProxy·Headroom·공용 MCP를 재시작하지 않습니다. 승인된 외부 1회성 작업으로만 재시작합니다.
- 5003·5551 포트는 쓰지 않습니다.
- 비밀값은 `{file:…}`이나 키 파일로만 참조하고 Git에 올리지 않습니다.
