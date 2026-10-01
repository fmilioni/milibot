#!/bin/bash
# Prints `<slug> <hash>` for every skill mirrored under $MILIBOT_SKILLS_ROOT.
ROOT="${MILIBOT_SKILLS_ROOT:?}"
[ -d "$ROOT" ] || exit 0
for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  printf '%s %s\n' "$(basename "$d")" "$(cat "$d${HASH_FILE:?}" 2>/dev/null || echo -)"
done
