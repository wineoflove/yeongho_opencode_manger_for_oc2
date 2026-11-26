#!/bin/bash
# Prints every OC2 service port in a ports.env file with the process listening on it.
#   bash check-ports.sh <ports.env>
set -euo pipefail

FILE=${1:?usage: check-ports.sh <ports.env>}

label() {
  case $1 in
    MANAGER_PORT) echo "Manager" ;;
    OPENCODE_PORT) echo "OC2 native" ;;
    PREVIEW_PORT) echo "preview" ;;
    CLIPROXY_PORT) echo "CLIProxy" ;;
    HEADROOM_PORT) echo "Headroom" ;;
    CONTEXT7_PORT) echo "Context7 MCP" ;;
    FIRECRAWL_PORT) echo "Firecrawl MCP" ;;
    MARKITDOWN_PORT) echo "MarkItDown MCP" ;;
    EXA_PORT) echo "Exa MCP" ;;
    *) echo "$1" ;;
  esac
}

printf '%-15s %-16s %-6s %s\n' "SERVICE" "VARIABLE" "PORT" "LISTENER"
while IFS='=' read -r name port || [ -n "$name" ]; do
  name=${name//[[:space:]]/}
  port=${port//[[:space:]\"\']/}
  [[ $name == *_PORT && $port =~ ^[0-9]+$ ]] || continue
  holder=$({ /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR == 2 {print $1 " (pid " $2 ")"}')
  if [ -z "$holder" ] && /usr/bin/nc -z -G 1 127.0.0.1 "$port" >/dev/null 2>&1; then
    holder="in use by another user's process (check with sudo lsof)"
  fi
  printf '%-15s %-16s %-6s %s\n' "$(label "$name")" "$name" "$port" "${holder:-free}"
done < "$FILE"
