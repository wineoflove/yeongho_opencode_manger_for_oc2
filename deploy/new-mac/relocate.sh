#!/bin/bash
# Rewrites the Mac mini home path (and account name in launchd plists) in the restored OC2 files
# so they work under this Mac's account.
#
#   bash relocate.sh <source home> [extra file...]     # e.g. /Users/yeonghokim ~/oc2-bundle/meta/schedules.json
#
# Only the operating files listed below are changed. Learning entries, reviews and application
# records keep their original paths because they are historical evidence.
set -euo pipefail

OLD=${1:?usage: relocate.sh <source home> [extra file...]}
shift
NEW=${NEW_HOME:-$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | awk '{print $2}')}
OLD_USER=$(basename "$OLD")
NEW_USER=${NEW_USER:-$(/usr/bin/id -un)}
S="$NEW/apps/ocm-v2-staging"
W="$S/data/workspace"
T="$W/.opencode/tooling"

if [ "$OLD" = "$NEW" ]; then
  echo "home is unchanged ($NEW); nothing to relocate"
  exit 0
fi

targets=(
  "$S/bin"
  "$NEW/apps/mcp-shared/README.md" "$NEW/apps/mcp-shared/bin"
  "$W/.config/opencode/AGENTS.md" "$W/.config/opencode/opencode.jsonc"
  "$W/.config/opencode/agents" "$W/.config/opencode/skills" "$W/.config/opencode/instructions"
  "$W/.config/opencode/commands" "$W/.config/opencode/bin" "$W/.config/opencode/plugins/comment-checker.js"
  "$W/repos/assistant/AGENTS.md" "$W/repos/assistant/opencode.json"
  "$W/repos/assistant/.opencode/agents" "$W/repos/assistant/.opencode/docs"
  "$W/repos/assistant/.opencode/bin" "$W/repos/assistant/.opencode/skills"
  "$W/repos/assistant/.opencode/schedule-reports.json"
  "$W/.opencode/learnings/README.md" "$W/.opencode/learnings/review-config.json"
  "$W/.opencode/learnings/application-config.json"
  "$T/playwright-mcp" "$T/ui-automation/bin" "$T/claude-design-mcp"
  "$T/lsp/README.md" "$T/lsp/typescript-language-server"
  "$NEW/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist"
  "$NEW/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist"
  "$@"
)

changed=0
while IFS= read -r -d '' file; do
  grep -qF "$OLD" "$file" || continue
  OLD="$OLD" NEW="$NEW" /usr/bin/perl -pi -e 's{\Q$ENV{OLD}\E(?![A-Za-z0-9._-])}{$ENV{NEW}}g' "$file"
  echo "relocated: $file"
  changed=$((changed + 1))
done < <(for t in "${targets[@]}"; do [ -e "$t" ] && find "$t" -type f -not -path '*/node_modules/*' -print0; done | xargs -0 grep -lI --null -- "$OLD" 2>/dev/null || true)

for plist in "$NEW/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist"; do
  [ -f "$plist" ] || continue
  for key in USER LOGNAME; do
    if [ "$(/usr/bin/plutil -extract "EnvironmentVariables.$key" raw "$plist" 2>/dev/null)" = "$OLD_USER" ]; then
      /usr/bin/plutil -replace "EnvironmentVariables.$key" -string "$NEW_USER" "$plist"
    fi
  done
  /usr/bin/plutil -lint "$plist" >/dev/null
done

echo "relocated $changed files from $OLD to $NEW"
left=$(for t in "${targets[@]}"; do [ -e "$t" ] && find "$t" -type f -not -path '*/node_modules/*' -print0; done | xargs -0 grep -lIF -- "$OLD" 2>/dev/null || true)
if [ -n "$left" ]; then
  echo "still mentions $OLD (check by hand):" >&2
  echo "$left" >&2
  exit 1
fi
