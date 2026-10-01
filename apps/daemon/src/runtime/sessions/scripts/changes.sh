#!/bin/bash
# What changed against BASE (see diff.ts), run after git.sh. Env: MODE, BASE, SESSION_CWD, SHADOW_DIR,
# IGNORED_PATTERNS, FILE_PATH, OLD_PATH, MAX_PATCH, and optionally ALL_PATCHES with MAX_TOTAL.
set -uo pipefail
cd "$SESSION_CWD" || { echo "cannot enter $SESSION_CWD" >&2; exit 3; }
tmp=$(mktemp -d) || exit 3
trap 'rm -rf "$tmp"' EXIT
# shellcheck disable=SC2034 # read by g() (git.sh)
EXCLUDES="$tmp/excludes"
write_excludes || exit 3
export GIT_INDEX_FILE="$tmp/index"
r read-tree "$BASE" || exit 4
r add -A -- . || exit 5
if [ -n "$FILE_PATH" ]; then
  if [ -n "$OLD_PATH" ]; then set -- "$FILE_PATH" "$OLD_PATH"; else set -- "$FILE_PATH"; fi
  r diff --cached --no-color --no-ext-diff -M --relative "$BASE" -- "$@" | head -c "$MAX_PATCH"
  exit 0
fi
if [ -n "${ALL_PATCHES:-}" ]; then
  r diff --cached -z --no-color --name-status -M --relative "$BASE" -- . > "$tmp/names" || exit 6
  while IFS= read -r -d '' code; do
    case "$code" in
      R*|C*) IFS= read -r -d '' old; IFS= read -r -d '' path; set -- "$path" "$old" ;;
      *) IFS= read -r -d '' path; set -- "$path" ;;
    esac
    printf '\0@@FILE\0%s\0' "$path"
    r diff --cached --no-color --no-ext-diff -M --relative "$BASE" -- "$@" | head -c "$MAX_PATCH"
  done < "$tmp/names" | head -c "$MAX_TOTAL"
  exit 0
fi
r diff --cached -z --no-color --numstat -M --relative "$BASE" -- . || exit 6
printf '\0@@\0'
r diff --cached -z --no-color --name-status -M --relative "$BASE" -- . || exit 6
