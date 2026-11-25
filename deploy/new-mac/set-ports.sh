#!/bin/bash
# Applies this Mac's service ports (ports.env) to the restored OC2 files.
#
#   bash set-ports.sh <ports.env>                      # restored files, from the ports applied last time
#   bash set-ports.sh --source <ports.env> <file...>   # only the given files, from the Mac mini ports
#
# The Mac mini ports come from the bundle manifest ($S/run/new-mac-meta/manifest.json). After a
# successful full run the applied ports are kept in $S/env/ports.applied.env so the script can be
# re-run with new values. Learning records are never rewritten.
set -euo pipefail
. "$(dirname "$0")/targets.sh"

NAMES=(MANAGER_PORT OPENCODE_PORT PREVIEW_PORT CLIPROXY_PORT HEADROOM_PORT
       CONTEXT7_PORT FIRECRAWL_PORT MARKITDOWN_PORT EXA_PORT)
usage() { echo "usage: set-ports.sh [--source] <ports.env> [file...]" >&2; exit 2; }

SOURCE_ONLY=false
if [ "${1:-}" = --source ]; then SOURCE_ONLY=true; shift; fi
WANT=${1:-}; [ -n "$WANT" ] || usage; shift
[ -f "$WANT" ] || { echo "ports file not found: $WANT" >&2; exit 2; }
if $SOURCE_ONLY && [ $# -eq 0 ]; then usage; fi

HOME_DIR=${NEW_HOME:-$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | awk '{print $2}')}
S="$HOME_DIR/apps/ocm-v2-staging"
MANIFEST="$S/run/new-mac-meta/manifest.json"
APPLIED="$S/env/ports.applied.env"

read_ports() {
  /usr/bin/python3 - "$1" "${NAMES[@]}" <<'EOF'
import json, re, sys
path, names = sys.argv[1], sys.argv[2:]
if path.endswith(".json"):
    values = json.load(open(path)).get("ports") or {}
else:
    values = {}
    for line in open(path):
        line = line.split("#", 1)[0].strip()
        if line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
missing = [n for n in names if n not in values]
if missing:
    sys.exit(f"{path}: missing {', '.join(missing)}")
for n in names:
    v = str(values[n])
    if not re.fullmatch(r"[0-9]+", v) or not 1024 <= int(v) <= 65535 or int(v) in (5003, 5551):
        sys.exit(f"{path}: {n}={v} must be 1024-65535 and not 5003/5551")
ports = [int(values[n]) for n in names]
if len(set(ports)) != len(ports):
    sys.exit(f"{path}: ports must be unique")
print(" ".join(str(p) for p in ports))
EOF
}

TO=($(read_ports "$WANT"))
if ! $SOURCE_ONLY && [ -f "$APPLIED" ]; then
  FROM=($(read_ports "$APPLIED"))
else
  [ -f "$MANIFEST" ] || { echo "bundle manifest not found: $MANIFEST" >&2; exit 2; }
  FROM=($(read_ports "$MANIFEST"))
fi

pairs=()
for i in "${!NAMES[@]}"; do
  if [ "${FROM[$i]}" != "${TO[$i]}" ]; then
    pairs+=("${NAMES[$i]}=${FROM[$i]}:${TO[$i]}")
    echo "${NAMES[$i]}: ${FROM[$i]} -> ${TO[$i]}"
  fi
done

if $SOURCE_ONLY; then
  targets() { printf '%s\0' "$@"; }
else
  targets() { oc2_targets "$HOME_DIR"; [ $# -eq 0 ] || printf '%s\0' "$@"; }
fi

changed=0
if [ ${#pairs[@]} -gt 0 ]; then
  while IFS= read -r -d '' file; do
    before=$(shasum -a 256 "$file")
    PAIRS="${pairs[*]}" /usr/bin/perl -pi -e '
      BEGIN { @p = map { /^(\w+)=(\d+):(\d+)$/ ? [$1, $2, $3] : () } split / /, $ENV{PAIRS} }
      for my $x (@p) { s{(?<![0-9A-Za-z])$x->[1](?![0-9A-Za-z])}{\@\@$x->[0]\@\@}g }
      for my $x (@p) { s{\@\@$x->[0]\@\@}{$x->[2]}g }
    ' "$file"
    if [ "$before" != "$(shasum -a 256 "$file")" ]; then
      echo "ports: $file"
      changed=$((changed + 1))
    fi
  done < <(targets "$@" | oc2_target_files | xargs -0 grep -lI --null -E -- '[0-9]{4,5}' 2>/dev/null || true)
fi

for plist in "$HOME_DIR"/Library/LaunchAgents/io.wineoflove.ocm2.*.plist; do
  [ -f "$plist" ] && /usr/bin/plutil -lint "$plist" >/dev/null
done
cfg="$S/data/workspace/.config/opencode/opencode.jsonc"
[ ! -f "$cfg" ] || /usr/bin/python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$cfg"

if ! $SOURCE_ONLY; then
  umask 077
  { for i in "${!NAMES[@]}"; do echo "${NAMES[$i]}=${TO[$i]}"; done; } > "$APPLIED.tmp"
  mv "$APPLIED.tmp" "$APPLIED"
fi
echo "changed ports in $changed files"

for port in "${TO[@]}"; do
  holder=$({ /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR == 2 {print $1 " pid " $2}')
  [ -z "$holder" ] || echo "note: port $port is already listening ($holder); fine if it is this Mac's OC2 service" >&2
done
