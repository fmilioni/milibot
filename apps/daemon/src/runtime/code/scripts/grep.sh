#!/bin/bash
# `rg` when the VM has it (respects .gitignore), else `grep -r` without the usual build folders.
# Env: SEARCH_DIR, TARGET, PATTERN, GLOB, IGNORE_CASE (1 = on), CONTEXT (lines, '' = none).
SKIPPED=(.git node_modules dist build target .venv __pycache__)
cd "$SEARCH_DIR" 2>/dev/null || { echo "No such folder: $SEARCH_DIR" >&2; exit 2; }
if command -v rg >/dev/null 2>&1; then
  set -- --line-number --no-heading --color never --max-columns 400 --max-columns-preview --hidden
  [ "$IGNORE_CASE" = 1 ] && set -- "$@" -i
  [ -n "$CONTEXT" ] && set -- "$@" -C "$CONTEXT"
  [ -n "$GLOB" ] && set -- "$@" -g "$GLOB"
  # rg only skips these through a .gitignore, which a folder may not have.
  for dir in "${SKIPPED[@]}"; do set -- "$@" -g "!$dir"; done
  rg "$@" -e "$PATTERN" -- "$TARGET"
else
  set -- -rnIE
  for dir in "${SKIPPED[@]}"; do set -- "$@" "--exclude-dir=$dir"; done
  [ "$IGNORE_CASE" = 1 ] && set -- "$@" -i
  [ -n "$CONTEXT" ] && set -- "$@" -C "$CONTEXT"
  [ -n "$GLOB" ] && set -- "$@" --include="$GLOB"
  grep "$@" -e "$PATTERN" -- "$TARGET"
fi
