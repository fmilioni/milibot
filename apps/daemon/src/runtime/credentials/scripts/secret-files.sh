#!/bin/bash
# Writes each bot's secrets to $MILIBOT_SECRETS_ROOT/<slug>/<NAME> (tmpfs; dir 0700, files 0600, owned by the
# user its shell runs as) and removes everything else there. Values arrive only on stdin, base64, one
# tab-separated `bot` or `secret` record per line.
set -eu
ROOT="${MILIBOT_SECRETS_ROOT:?}"
umask 077
mkdir -p "$ROOT"
# mkdir -p under umask 077 leaves the parent (/run/milibot) at 0700, which hides every bot's folder.
chmod 0711 "$(dirname "$ROOT")" "$ROOT"
keep=$(mktemp)
trap 'rm -f "$keep"' EXIT
current=''
while IFS=$'\t' read -r kind slug owner name value; do
  if [ "$kind" = bot ]; then
    current=''
    id -u "$owner" >/dev/null 2>&1 || continue
    mkdir -p "$ROOT/$slug"
    chown "$owner:" "$ROOT/$slug"
    chmod 0700 "$ROOT/$slug"
    current="$slug"
    echo "$slug/" >> "$keep"
  elif [ "$kind" = secret ] && [ -n "$current" ] && [ "$slug" = "$current" ]; then
    file="$ROOT/$slug/$name"
    printf '%s' "$value" | base64 -d > "$file.tmp"
    chown "$owner:" "$file.tmp"
    chmod 0600 "$file.tmp"
    mv -f "$file.tmp" "$file"
    echo "$slug/$name" >> "$keep"
  fi
done
for dir in "$ROOT"/*/; do
  [ -d "$dir" ] || continue
  slug=$(basename "$dir")
  if ! grep -qxF "$slug/" "$keep"; then rm -rf "$dir"; continue; fi
  for file in "$dir"* "$dir".[!.]*; do
    [ -e "$file" ] || continue
    grep -qxF "$slug/$(basename "$file")" "$keep" || rm -rf "$file"
  done
done
