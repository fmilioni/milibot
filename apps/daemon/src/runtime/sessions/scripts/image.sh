#!/bin/bash
# An image at BASE (BEFORE_PATH) and in the folder (AFTER_PATH), see diff.ts; run after git.sh. Env: MODE, BASE,
# SESSION_CWD, SHADOW_DIR, BEFORE_PATH, AFTER_PATH, MAX_IMAGE.
set -uo pipefail
cd "$SESSION_CWD" || { echo "cannot enter $SESSION_CWD" >&2; exit 3; }
if [ -n "$BEFORE_PATH" ] && size=$(r cat-file -s "$BASE:./$BEFORE_PATH" 2>/dev/null); then
  if [ "$size" -le "$MAX_IMAGE" ]; then
    printf 'BEFORE %s ' "$size"
    r cat-file blob "$BASE:./$BEFORE_PATH" | base64 | tr -d '\n' || exit 4
    echo
  else
    echo "BEFORE $size -"
  fi
fi
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
