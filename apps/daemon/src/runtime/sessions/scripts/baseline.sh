#!/bin/bash
# Baseline of a session's folder (see diff.ts), run after git.sh. Env: MODE=git, SESSION_CWD, SHADOW_DIR,
# MAX_FILES, MAX_KB, IGNORED_PATTERNS. Prints `MODE=`/`BASE=` lines, or `ERROR=too_large`.
set -uo pipefail
cd "$SESSION_CWD" || { echo "cannot enter $SESSION_CWD" >&2; exit 3; }
if g rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  base=$(g rev-parse --verify -q HEAD) || base=$(g hash-object -t tree /dev/null)
  echo "MODE=git"
  echo "BASE=$base"
  exit 0
fi
# shellcheck disable=SC2034 # read by r() (git.sh)
MODE=shadow
EXCLUDES=$(mktemp) || exit 3
trap 'rm -f "$EXCLUDES"' EXIT
write_excludes || exit 3
mkdir -p "$(dirname "$SHADOW_DIR")" || exit 4
r init -q || exit 4
mkdir -p "$SHADOW_DIR/info"
printf '/.milibot/\n' >> "$SHADOW_DIR/info/exclude"
files=$(r ls-files --others --exclude-standard 2>/dev/null | head -n $((MAX_FILES + 1)) | wc -l)
kb=0
if [ "$files" -gt 0 ] && [ "$files" -le "$MAX_FILES" ]; then
  kb=$(r ls-files -z --others --exclude-standard | xargs -0 du -sk -- 2>/dev/null | awk '{ s += $1 } END { printf "%d", s }')
  [ -n "$kb" ] || kb=0
fi
if [ "$files" -gt "$MAX_FILES" ] || [ "$kb" -gt "$MAX_KB" ]; then
  rm -rf -- "$SHADOW_DIR"
  echo "ERROR=too_large"
  exit 0
fi
r add -A -- . || exit 5
r -c user.name=milibot -c user.email=milibot@localhost commit -q --allow-empty --no-verify -m baseline || exit 6
echo "MODE=shadow"
echo "BASE=$(r rev-parse HEAD)"
