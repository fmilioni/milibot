#!/bin/bash
# Replaces the skills in $REPLACE with the folders of the tar on stdin (base64) and deletes the ones in
# $REMOVE. Everything ends up root-owned and read-only for the bots: folders 0755, files 0644, 0755 when
# they were executable.
set -eu
ROOT="${MILIBOT_SKILLS_ROOT:?}"
mkdir -p "$ROOT"
chmod 0755 "$ROOT"
stage=$(mktemp -d "$ROOT/.stage.XXXXXX")
trap 'rm -rf "$stage"' EXIT
base64 -d > "$stage/.in.tar"
mkdir "$stage/x"
tar -x -f "$stage/.in.tar" -C "$stage/x" --no-same-owner
rm -f "$stage/.in.tar"
if [ "$(id -u)" = 0 ]; then chown -R root:root "$stage/x"; fi
find "$stage/x" -type d -exec chmod 0755 {} +
# shellcheck disable=SC2016 # the inner script gets its files as arguments
find "$stage/x" -type f -exec sh -c 'for f; do if [ -x "$f" ]; then chmod 0755 "$f"; else chmod 0644 "$f"; fi; done' _ {} +
for slug in ${REMOVE:-}; do rm -rf "${ROOT:?}/$slug"; done
for slug in ${REPLACE:-}; do
  rm -rf "${ROOT:?}/$slug"
  if [ -d "$stage/x/$slug" ]; then mv "$stage/x/$slug" "$ROOT/$slug"; fi
done
