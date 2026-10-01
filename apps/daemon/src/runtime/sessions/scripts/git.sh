#!/bin/bash
# Prepended to the other session diff scripts. `r` runs git on the session folder (SESSION_CWD): its own
# repository with MODE=git, the snapshot git dir SHADOW_DIR with MODE=shadow (read at call time). EXCLUDES, when
# set, is a file of extra ignore patterns passed as core.excludesFile, so neither the repository nor the shadow
# git dir is ever changed.
g() {
  if [ -n "${EXCLUDES:-}" ]; then
    git -c safe.directory='*' -c core.autocrlf=false -c core.quotepath=false -c "core.excludesFile=$EXCLUDES" "$@"
  else
    git -c safe.directory='*' -c core.autocrlf=false -c core.quotepath=false "$@"
  fi
}
r() {
  if [ "$MODE" = shadow ]; then
    g --git-dir="$SHADOW_DIR" --work-tree="$SESSION_CWD" "$@"
  else
    g "$@"
  fi
}
# IGNORED_PATTERNS: one pattern per line.
write_excludes() { printf '%s\n' "$IGNORED_PATTERNS" > "$EXCLUDES"; }
