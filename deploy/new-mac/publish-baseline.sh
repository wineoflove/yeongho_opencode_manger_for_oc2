#!/bin/bash
# Publishes the Mac mini's current state as the install baseline for new Macs.
#
#   bash deploy/new-mac/publish-baseline.sh            # run on the Mac mini
#   bash deploy/new-mac/publish-baseline.sh --local    # refresh this checkout only; no release, commit or push
#
# 1. Rebuilds the bundle and versions.env from the running Mac mini (make-bundle.sh).
# 2. Checks that the running CLIProxy binary is the official release for its version.
# 3. Creates the OC2 release (binary + SHA256SUMS) on wineoflove/yeongho_opencode2 if that version has none.
# 4. Commits and pushes deploy/new-mac to origin/main only when its content changed.
# Works in a temporary worktree of origin/main, so the serving checkout is never touched.
set -euo pipefail
umask 077

USER_NAME=$(/usr/bin/id -un)
U=$(/usr/bin/dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')
S="$U/apps/ocm-v2-staging"
PORT_REPO="$S/port"
OC2_REPO=wineoflove/yeongho_opencode2
export PATH="$U/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
git_remote() { git -C "$1" -c credential.helper= -c 'credential.helper=!gh auth git-credential' "${@:2}"; }

LOCAL=false
[ "${1:-}" = --local ] && LOCAL=true
WORK=$(mktemp -d "$S/tmp/publish-baseline.XXXXXX")
if $LOCAL; then
  TREE=$(cd "$(dirname "$0")/../.." && pwd)
  cleanup() { rm -rf "$WORK"; }
else
  TREE="$WORK/tree"
  cleanup() {
    git -C "$PORT_REPO" worktree remove --force "$TREE" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  }
fi
trap cleanup EXIT

if ! $LOCAL; then
  git_remote "$PORT_REPO" fetch -q origin main
  git -C "$PORT_REPO" worktree add -q --detach "$TREE" origin/main
fi
BASE=$(git -C "$TREE" rev-parse HEAD)

bash "$TREE/deploy/new-mac/make-bundle.sh" 2>&1 | grep -v '^Using Python' >&2
set -a; . "$TREE/deploy/new-mac/versions.env"; set +a

echo "check: CLIProxy $CLIPROXY_VERSION is the official darwin_aarch64 release" >&2
ASSET="CLIProxyAPI_${CLIPROXY_VERSION}_darwin_aarch64.tar.gz"
DIGEST=$(gh api "repos/router-for-me/CLIProxyAPI/releases/tags/v$CLIPROXY_VERSION" \
  -q ".assets[] | select(.name == \"$ASSET\") | .digest" | sed 's/^sha256://')
[ -n "$DIGEST" ] || { echo "no official $ASSET release asset" >&2; exit 1; }
curl -fsSL -o "$WORK/$ASSET" "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$CLIPROXY_VERSION/$ASSET"
[ "$(shasum -a 256 "$WORK/$ASSET" | cut -d' ' -f1)" = "$DIGEST" ] || { echo "$ASSET digest mismatch" >&2; exit 1; }
tar -xzf "$WORK/$ASSET" -C "$WORK" cli-proxy-api
[ "$(shasum -a 256 "$WORK/cli-proxy-api" | cut -d' ' -f1)" = "$CLIPROXY_BIN_SHA256" ] \
  || { echo "running CLIProxy is not the official $CLIPROXY_VERSION binary" >&2; exit 1; }
printf 'CLIPROXY_TGZ_SHA256=%s\n' "$DIGEST" >> "$TREE/deploy/new-mac/versions.env"

TAG="v$OC2_VERSION"
if gh release view "$TAG" -R "$OC2_REPO" >/dev/null 2>&1; then
  echo "check: OC2 release $TAG exists" >&2
  REL_SHA=$(gh release download "$TAG" -R "$OC2_REPO" -p SHA256SUMS -O - | awk '$2 == "opencode" {print $1}')
  [ "$REL_SHA" = "$OC2_SHA256" ] || { echo "release $TAG binary differs from the running OC2 binary" >&2; exit 1; }
elif $LOCAL; then
  echo "local: OC2 release $TAG is missing; run without --local to publish it" >&2
else
  echo "publish: OC2 release $TAG" >&2
  NATIVE=$(grep '^OPENCODE_BIN=' "$S/env/staging.env" | cut -d= -f2-)
  NAME="opencode-$OC2_VERSION-darwin-arm64.tar.gz"
  COPYFILE_DISABLE=1 tar -C "$(dirname "$NATIVE")" --uid 0 --gid 0 --uname root --gname wheel -czf "$WORK/$NAME" opencode
  (cd "$WORK" && shasum -a 256 "$NAME" > SHA256SUMS && printf '%s  opencode\n' "$OC2_SHA256" >> SHA256SUMS)
  SRC_HEAD=$(gh api "repos/$OC2_REPO/commits/main" -q .sha)
  SRC_TITLE=$(gh api "repos/$OC2_REPO/commits/main" -q '.commit.message | split("\n")[0]')
  case "$SRC_TITLE" in
    *"$OC2_VERSION"*) SRC_NOTE="Source: main $SRC_HEAD ($SRC_TITLE)." ;;
    *) SRC_NOTE="Source: main $SRC_HEAD does not name $OC2_VERSION yet; push the matching fork source before building from source." ;;
  esac
  printf '%s\n\n- Version: `%s`\n- Binary `opencode` SHA-256: `%s` (the file serving production on the Mac mini)\n- %s\n' \
    "OC2 custom native build for macOS arm64 (Apple Silicon)." "$OC2_VERSION" "$OC2_SHA256" "$SRC_NOTE" > "$WORK/notes.md"
  gh release create "$TAG" -R "$OC2_REPO" --target "$SRC_HEAD" --title "OC2 custom $OC2_VERSION" \
    --notes-file "$WORK/notes.md" --latest "$WORK/$NAME" "$WORK/SHA256SUMS"
  echo "$SRC_NOTE" >&2
fi

same_content() {
  local old="$WORK/old" new="$WORK/new"
  mkdir -p "$old" "$new"
  git -C "$TREE" show "$BASE:deploy/new-mac/oc2-macmini-bundle.tgz" | tar -xzf - -C "$old"
  tar -xzf "$TREE/deploy/new-mac/oc2-macmini-bundle.tgz" -C "$new"
  for dir in "$old" "$new"; do
    /usr/bin/python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop("createdAt", None); json.dump(d, open(p, "w"), indent=2, sort_keys=True)' "$dir/meta/manifest.json"
  done
  diff -rq "$old" "$new" >/dev/null &&
    git -C "$TREE" show "$BASE:deploy/new-mac/versions.env" 2>/dev/null | cmp -s - "$TREE/deploy/new-mac/versions.env"
}

if same_content; then
  echo "result: baseline unchanged (${BASE:0:8})"
  exit 0
fi
if $LOCAL; then
  echo "result: baseline refreshed in $TREE/deploy/new-mac (not committed)"
  exit 0
fi

git -C "$TREE" add deploy/new-mac/oc2-macmini-bundle.tgz deploy/new-mac/SHA256SUMS deploy/new-mac/versions.env
git -C "$TREE" -c user.name="${GIT_AUTHOR_NAME:-OpenCode Agent}" -c user.email="${GIT_AUTHOR_EMAIL:-90123921+wineoflove@users.noreply.github.com}" \
  commit -q -m "chore(new-mac): refresh install baseline (OC2 $OC2_VERSION, CLIProxy $CLIPROXY_VERSION, Headroom $HEADROOM_VERSION)"
git_remote "$TREE" push -q origin HEAD:refs/heads/main
NEW=$(git -C "$TREE" rev-parse HEAD)
[ "$(git_remote "$TREE" ls-remote origin refs/heads/main | cut -f1)" = "$NEW" ] || { echo "push not visible on origin/main" >&2; exit 1; }
echo "result: baseline published ${BASE:0:8} -> ${NEW:0:8}"
