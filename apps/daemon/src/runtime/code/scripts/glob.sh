#!/bin/bash
# Files under SEARCH_DIR whose relative path matches the extended regex REGEX, at most SCAN of them, as
# `mtime<TAB>path` lines (without the usual build folders).
SKIPPED=(.git node_modules dist build target .venv __pycache__)
cd "$SEARCH_DIR" 2>/dev/null || { echo "No such folder: $SEARCH_DIR" >&2; exit 2; }
{
  if command -v rg >/dev/null 2>&1; then
    skip=()
    for dir in "${SKIPPED[@]}"; do skip+=(-g "!$dir"); done
    rg --files --hidden "${skip[@]}" 2>/dev/null
  else
    prune=()
    for dir in "${SKIPPED[@]}"; do
      [ ${#prune[@]} -gt 0 ] && prune+=(-o)
      prune+=(-name "$dir")
    done
    find . \( "${prune[@]}" \) -prune -o -type f -print 2>/dev/null | sed 's#^\./##'
  fi
} | grep -E -- "$REGEX" | head -n "$SCAN" | while IFS= read -r f; do
  t=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null || echo 0)
  printf '%s\t%s\n' "$t" "$f"
done
