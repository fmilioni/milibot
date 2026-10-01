#!/bin/bash
# Applies the unified diff read from stdin in PATCH_DIR, all or nothing (`git apply` checks every hunk first):
# with a/ b/ prefixes, else without; hunk line counts as written, else recounted (models miscount them).
# Prints the numstat of the touched files, then `::applied::`.
cd "$PATCH_DIR" 2>/dev/null || { echo "No such folder: $PATCH_DIR" >&2; exit 2; }
tmp=$(mktemp) || exit 2
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
g() { git -c core.quotepath=false -c safe.directory='*' "$@"; }
for p in 1 0; do
  for count in --no-recount --recount; do
    [ "$count" = --no-recount ] && count=
    # shellcheck disable=SC2086 # an empty $count must vanish
    if g apply -p$p $count --whitespace=nowarn --check "$tmp" 2>/dev/null; then
      # shellcheck disable=SC2086
      g apply -p$p $count --numstat "$tmp"
      # shellcheck disable=SC2086
      g apply -p$p $count --whitespace=nowarn "$tmp" || exit 1
      echo "::applied::"
      exit 0
    fi
  done
done
g apply -p1 --whitespace=nowarn --check "$tmp"
exit 1
