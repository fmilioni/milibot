#!/bin/bash
# Runs as root with CODEX_VERSION and CODEX_REAL: installs @openai/codex@$CODEX_VERSION with npm when the VM has
# another version (or none) and points CODEX_REAL at it. The guest agent's /usr/local/bin/codex wrapper (ahead of
# npm's own link in every PATH) runs it as `agent` with its login.
set -eu
real=$CODEX_REAL
if [ "$("$real" --version 2>/dev/null || true)" != "codex-cli $CODEX_VERSION" ]; then
  npm install -g --no-audit --no-fund --loglevel=error "@openai/codex@$CODEX_VERSION" >&2
  install -d -m 0755 "$(dirname "$real")"
  ln -sfn "$(npm prefix -g)/bin/codex" "$real"
  echo CODEX=installed
fi
install -d -m 0700 -o agent -g agent /home/agent/.codex
"$real" --version
