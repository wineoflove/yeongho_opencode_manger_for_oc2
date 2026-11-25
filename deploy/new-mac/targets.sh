# Sourced by relocate.sh and set-ports.sh: the restored operating files that may be rewritten.
# Learning entries, reviews and application records are deliberately absent (historical evidence).
oc2_targets() {
  local home=$1
  local S="$home/apps/ocm-v2-staging"
  local W="$S/data/workspace"
  local T="$W/.opencode/tooling"
  printf '%s\0' \
    "$S/bin" \
    "$home/apps/mcp-shared/README.md" "$home/apps/mcp-shared/bin" \
    "$W/.config/opencode/AGENTS.md" "$W/.config/opencode/opencode.jsonc" \
    "$W/.config/opencode/agents" "$W/.config/opencode/skills" "$W/.config/opencode/instructions" \
    "$W/.config/opencode/commands" "$W/.config/opencode/bin" "$W/.config/opencode/plugins/comment-checker.js" \
    "$W/repos/assistant/AGENTS.md" "$W/repos/assistant/opencode.json" \
    "$W/repos/assistant/.opencode/agents" "$W/repos/assistant/.opencode/docs" \
    "$W/repos/assistant/.opencode/bin" "$W/repos/assistant/.opencode/skills" \
    "$W/repos/assistant/.opencode/schedule-reports.json" \
    "$W/.opencode/learnings/README.md" "$W/.opencode/learnings/review-config.json" \
    "$W/.opencode/learnings/application-config.json" \
    "$T/playwright-mcp" "$T/ui-automation/bin" "$T/claude-design-mcp" \
    "$T/lsp/README.md" "$T/lsp/typescript-language-server" \
    "$home/Library/LaunchAgents/io.wineoflove.ocm2.backend.plist" \
    "$home/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist"
}

oc2_target_files() {
  local path
  while IFS= read -r -d '' path; do
    [ -e "$path" ] && find "$path" -type f -not -path '*/node_modules/*' -print0
  done
}
