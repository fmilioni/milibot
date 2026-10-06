#!/bin/bash
# An image at BASE (BEFORE_PATH) and in the folder (AFTER_PATH), see diff.ts; run after git.sh. Env: MODE, BASE,
# SESSION_CWD, SHADOW_DIR, BEFORE_PATH, AFTER_PATH, MAX_IMAGE, and the saved tree of a finished session
# (SAVED_TREE, SAVED_GIT_DIR, SAVED_PREFIX) to read both sides from when the folder is gone. Prints GONE when the
# folder is gone and a side cannot be read.
set -uo pipefail

# Prints a side (`<SIDE> <size> <base64>`, or `-` instead of the data when too large) from a blob; fails when
# there is no such blob.
blob_side() {
  local side=$1 spec=$2 size
  size=$(git_blob cat-file -s "$spec" 2>/dev/null) || return 1
  if [ "$size" -le "$MAX_IMAGE" ]; then
    printf '%s %s ' "$side" "$size"
    git_blob cat-file blob "$spec" | base64 | tr -d '\n' || exit 4
    echo
  else
    echo "$side $size -"
  fi
}

if ! cd "$SESSION_CWD" 2>/dev/null; then
  if [ -z "${SAVED_TREE:-}" ] || [ ! -d "${SAVED_GIT_DIR:-}" ]; then echo GONE; exit 0; fi
  git_blob() { g --git-dir="$SAVED_GIT_DIR" "$@"; }
  out=''
  if [ -n "$BEFORE_PATH" ]; then out=$(blob_side BEFORE "$BASE:$SAVED_PREFIX$BEFORE_PATH") || { echo GONE; exit 0; }; fi
  if [ -n "$AFTER_PATH" ]; then
    after=$(blob_side AFTER "$SAVED_TREE:$SAVED_PREFIX$AFTER_PATH") || { echo GONE; exit 0; }
    out="$out${out:+$'\n'}$after"
  fi
  printf '%s\n' "$out"
  exit 0
fi

git_blob() { r "$@"; }
if [ -n "$BEFORE_PATH" ]; then blob_side BEFORE "$BASE:./$BEFORE_PATH"; fi
if [ -n "$AFTER_PATH" ] && [ -f "$AFTER_PATH" ]; then
  size=$(( $(wc -c < "$AFTER_PATH") )) || exit 5
  if [ "$size" -le "$MAX_IMAGE" ]; then
    printf 'AFTER %s ' "$size"
    base64 < "$AFTER_PATH" | tr -d '\n' || exit 5
    echo
  else
    echo "AFTER $size -"
  fi
fi
