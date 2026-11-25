#!/bin/bash
# Rewrites the Mac mini home path (and account name in launchd plists) in the restored OC2 files
# so they work under this Mac's account.
#
#   bash relocate.sh <source home> [extra file...]     # e.g. /Users/yeonghokim $S/run/new-mac-meta/schedules.json
#
# Only the files from targets.sh plus the extra files are changed. Learning entries, reviews and
# application records keep their original paths because they are historical evidence.
set -euo pipefail
. "$(dirname "$0")/targets.sh"

OLD=${1:?usage: relocate.sh <source home> [extra file...]}
shift
NEW=${NEW_HOME:-$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | awk '{print $2}')}
OLD_USER=$(basename "$OLD")
NEW_USER=${NEW_USER:-$(/usr/bin/id -un)}

if [ "$OLD" = "$NEW" ]; then
  echo "home is unchanged ($NEW); nothing to relocate"
  exit 0
fi

targets() { oc2_targets "$NEW"; [ $# -eq 0 ] || printf '%s\0' "$@"; }

changed=0
while IFS= read -r -d '' file; do
  OLD="$OLD" NEW="$NEW" /usr/bin/perl -pi -e 's{\Q$ENV{OLD}\E(?![A-Za-z0-9._-])}{$ENV{NEW}}g' "$file"
  echo "relocated: $file"
  changed=$((changed + 1))
done < <(targets "$@" | oc2_target_files | xargs -0 grep -lI --null -- "$OLD" 2>/dev/null || true)

plist="$NEW/Library/LaunchAgents/io.wineoflove.ocm2.headroom.plist"
if [ -f "$plist" ]; then
  for key in USER LOGNAME; do
    if [ "$(/usr/bin/plutil -extract "EnvironmentVariables.$key" raw "$plist" 2>/dev/null)" = "$OLD_USER" ]; then
      /usr/bin/plutil -replace "EnvironmentVariables.$key" -string "$NEW_USER" "$plist"
    fi
  done
  /usr/bin/plutil -lint "$plist" >/dev/null
fi

echo "relocated $changed files from $OLD to $NEW"
left=$(targets "$@" | oc2_target_files | xargs -0 grep -lIF -- "$OLD" 2>/dev/null || true)
if [ -n "$left" ]; then
  echo "still mentions $OLD (check by hand):" >&2
  echo "$left" >&2
  exit 1
fi
