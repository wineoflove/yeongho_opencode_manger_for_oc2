#!/bin/bash
# Builds deploy/new-mac/oc2-macmini-bundle.tgz on the Mac mini: the OC2 operating files that are
# not in any Git repository, with secrets excluded. Read-only towards the running services.
#
#   bash deploy/new-mac/make-bundle.sh            # writes next to this script
#
# The archive holds paths relative to the source account's home under home/, plus meta/ with the
# schedule export, pinned Python requirements and a manifest. relocate.sh rewrites the source home
# on the target Mac.
set -euo pipefail
umask 077
export COPYFILE_DISABLE=1

OUT_DIR=$(cd "$(dirname "$0")" && pwd)
USER_NAME=$(/usr/bin/id -un)
U=$(/usr/bin/dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')
S="$U/apps/ocm-v2-staging"
W="$S/data/workspace"
T="$W/.opencode/tooling"
REL_S=${S#"$U"/}
REL_W=${W#"$U"/}
REL_T=${T#"$U"/}

STAGE=$(mktemp -d "$S/tmp/new-mac-bundle.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/home" "$STAGE/meta"

files=(
  "$REL_S/bin/launchd-backend.sh" "$REL_S/bin/start.sh" "$REL_S/bin/stop.sh"
  "$REL_S/bin/restart.sh" "$REL_S/bin/status.sh"
  "$REL_S/bin/build-oc2.sh" "$REL_S/bin/deploy-oc2-code.sh"
  "$REL_S/bin/oc2-active.mjs" "$REL_S/bin/cleanup-rr-sessions.mjs"
  apps/mcp-shared/README.md apps/mcp-shared/bin
  "$REL_T/claude-design-mcp/package.json" "$REL_T/claude-design-mcp/server.mjs" "$REL_T/claude-design-mcp/src"
  "$REL_T/playwright-mcp"
  "$REL_T/ui-automation/package.json" "$REL_T/ui-automation/package-lock.json" "$REL_T/ui-automation/bin"
  "$REL_T/npm-mcp/context7/package.json" "$REL_T/npm-mcp/context7/package-lock.json"
  "$REL_T/npm-mcp/firecrawl/package.json" "$REL_T/npm-mcp/firecrawl/package-lock.json"
  "$REL_T/npm-mcp/playwright/package.json" "$REL_T/npm-mcp/playwright/package-lock.json"
  "$REL_W/.config/opencode/opencode.jsonc"
  "$REL_W/repos/assistant/.opencode/bin/schedule-report.mjs"
  "$REL_W/repos/assistant/.opencode/schedule-reports.json"
  Library/LaunchAgents/io.wineoflove.ocm2.backend.plist
  Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist
)
(cd "$U" && for f in "${files[@]}"; do [ -e "$f" ] || { echo "missing: $U/$f" >&2; exit 1; }; done)
(cd "$U" && /usr/bin/rsync -aR "${files[@]}" "$STAGE/home/")
find "$STAGE/home" -name .DS_Store -delete

# The target Mac uses fixed locations for the parts that live in dated run/ directories here.
PROXY_NOW=$(grep '^OCM_CLAUDE_PROXY_API_KEY_FILE=' "$S/env/staging.env" | cut -d= -f2- | sed 's#/keys/upstream.key$##')
STAGE="$STAGE" U="$U" S="$S" W="$W" PROXY_NOW="$PROXY_NOW" /usr/bin/python3 - <<'EOF'
import json, os, plistlib
stage, U, S, W = (os.environ[k] for k in ("STAGE", "U", "S", "W"))
home = os.path.join(stage, "home")
cfg_path = os.path.join(home, os.path.relpath(f"{W}/.config/opencode/opencode.jsonc", U))
text = open(cfg_path).read().replace(os.environ["PROXY_NOW"], f"{S}/cliproxy/package")
cfg = json.loads(text)
codegraph = cfg["mcp"]["servers"]["codegraph"]
codegraph["command"] = [f"{U}/.codegraph/current/bin/codegraph", "serve", "--mcp"]
codegraph["environment"]["CODEGRAPH_INSTALL_DIR"] = f"{U}/.codegraph"
open(cfg_path, "w").write(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")

plist_path = os.path.join(home, "Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist")
plist = plistlib.load(open(plist_path, "rb"))
venv = f"{W}/.opencode/tooling/headroom/.venv"
plist["ProgramArguments"][0] = f"{venv}/bin/python"
plist["EnvironmentVariables"]["ORT_DYLIB_PATH"] = (
    f"{venv}/lib/python3.12/site-packages/onnxruntime/capi/libonnxruntime.1.31.0.dylib")
plistlib.dump(plist, open(plist_path, "wb"))
EOF

HEADROOM_PY=$(/usr/bin/plutil -extract ProgramArguments.0 raw "$U/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist")
[ -x "$HEADROOM_PY" ] || { echo "Headroom Python not found: '$HEADROOM_PY'" >&2; exit 1; }
uv pip freeze --python "$HEADROOM_PY" > "$STAGE/meta/headroom-requirements.txt"
grep -q '^headroom-ai==' "$STAGE/meta/headroom-requirements.txt"
uv pip freeze --python "$T/markitdown/.venv/bin/python" > "$STAGE/meta/markitdown-requirements.txt"
grep -q '^markitdown-mcp==' "$STAGE/meta/markitdown-requirements.txt"

/usr/bin/sqlite3 -readonly -json "$S/data/db/opencode-manager.db" \
  "SELECT id, name, description, enabled, schedule_mode AS scheduleMode,
          cron_expression AS cronExpression, interval_minutes AS intervalMinutes,
          timezone, agent_slug AS agentSlug, model, workspace_mode AS workspaceMode,
          permission_config AS permissionConfig, prompt
     FROM schedule_jobs WHERE repo_id = 0 AND enabled = 1 ORDER BY id" > "$STAGE/meta/schedules.json"

# Refuse to package any known secret value or a token-shaped string.
secret_files=(
  "$PROXY_NOW"/keys/*.key
  "$U/.local/share/opencode-manager/secrets/exa-api-key"
  "$U/.local/share/opencode-manager/secrets/playwright-extension-token"
  "$W/.config/opencode/service-ocm-pool.json"
  "$U/.local/share/ocm-migration-20260930/private/mcporter.json"
  "$S/env/staging.env"
)
STAGE="$STAGE" /usr/bin/python3 - "${secret_files[@]}" <<'EOF'
import json, os, re, sys
values = set()
for path in sys.argv[1:]:
    if not os.path.isfile(path):
        continue
    raw = open(path, errors="ignore").read()
    if path.endswith(".json"):
        def walk(node, secret=False):
            if isinstance(node, dict):
                for k, v in node.items():
                    walk(v, secret or bool(re.search(r"key|token|secret|password|authorization", k, re.I)))
            elif isinstance(node, list):
                for v in node: walk(v, secret)
            elif secret and isinstance(node, str) and len(node) >= 16:
                values.add(node)
        walk(json.loads(raw))
    elif path.endswith(".env"):
        for line in raw.splitlines():
            key, _, value = line.partition("=")
            if re.search(r"SECRET|PASSWORD|TOKEN|KEY$", key) and len(value) >= 8:
                values.add(value)
    elif len(raw.strip()) >= 16:
        values.add(raw.strip())
pattern = re.compile(r"(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{20,}|fc-[a-f0-9]{24,})")
bad = []
for root, _, names in os.walk(os.environ["STAGE"]):
    for name in names:
        path = os.path.join(root, name)
        text = open(path, errors="ignore").read()
        if any(v in text for v in values) or pattern.search(text):
            bad.append(os.path.relpath(path, os.environ["STAGE"]))
if bad:
    sys.exit("secret-like content found, refusing to bundle: " + ", ".join(bad))
print(f"secret scan: {len(values)} known values checked, clean")
EOF

NATIVE=$(grep '^OPENCODE_BIN=' "$S/env/staging.env" | cut -d= -f2-)
{
  printf '{\n  "createdAt": "%s",\n  "sourceHome": "%s",\n  "sourceUser": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$U" "$USER_NAME"
  printf '  "opencodeVersion": "%s",\n' "$("$NATIVE" --version 2>/dev/null | awk '{print $NF}')"
  printf '  "opencodeSha256": "%s"\n}\n' "$(shasum -a 256 "$NATIVE" | cut -d' ' -f1)"
} > "$STAGE/meta/manifest.json"

/usr/bin/tar -C "$STAGE" --uid 0 --gid 0 --uname root --gname wheel -czf "$OUT_DIR/oc2-macmini-bundle.tgz" home meta
(cd "$OUT_DIR" && shasum -a 256 oc2-macmini-bundle.tgz > SHA256SUMS)
echo "bundle: $OUT_DIR/oc2-macmini-bundle.tgz ($(du -h "$OUT_DIR/oc2-macmini-bundle.tgz" | cut -f1))"
cat "$OUT_DIR/SHA256SUMS"
