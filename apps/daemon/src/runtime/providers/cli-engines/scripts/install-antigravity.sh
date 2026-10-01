#!/bin/bash
# Runs as root with the AGY_* variables of the daemon's `antigravity.ts` and Milibot's MCP bridge on stdin.
# Installs the pinned agy build when the VM has another one (or none), checked against its sha512, in a
# root-owned folder (agy then skips its self-update), and sets up agent's account: the bridge as the `milibot`
# MCP server, /workspace trusted, and ~/.gemini/config/agents pointing at the folder Milibot writes lanes'
# agents to. Prints the installed version and the bridge's sha256.
set -eu
case "$(uname -m)" in
  aarch64) path=$AGY_PATH_AARCH64 sha=$AGY_SHA_AARCH64 ;;
  x86_64) path=$AGY_PATH_X86_64 sha=$AGY_SHA_X86_64 ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
real=$AGY_REAL
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ "$("$real" --version 2>/dev/null || true)" != "$AGY_VERSION" ]; then
  curl -fsSL --retry 3 -o "$tmp/agy.tgz" "$AGY_URL/$path"
  echo "$sha  $tmp/agy.tgz" | sha512sum -c - >&2
  tar -xzf "$tmp/agy.tgz" -C "$tmp" antigravity
  dir=$(dirname "$real")/agy-$AGY_VERSION
  install -d -m 0755 "$dir"
  install -m 0755 "$tmp/antigravity" "$dir/antigravity"
  ln -sfn "$dir/antigravity" "$real"
  echo AGY=installed
fi
cat > "$tmp/bridge.js"
install -m 0644 "$tmp/bridge.js" "$AGY_BRIDGE"

home=/home/agent
install -d -m 0700 -o agent -g agent "$home/.gemini" "$home/.gemini/config" "$home/.milibot" \
  "$home/.milibot/$AGY_AGENTS_DIR"
agents=$home/.gemini/config/agents
if [ ! -L "$agents" ]; then
  if [ -d "$agents" ]; then
    cp -a "$agents/." "$home/.milibot/$AGY_AGENTS_DIR/"
    chmod 0700 "$home/.milibot/$AGY_AGENTS_DIR"
    rm -rf "$agents"
  fi
  ln -s "$home/.milibot/$AGY_AGENTS_DIR" "$agents"
  chown -h agent:agent "$agents"
fi

# Entries of agent's own configs are kept; a file agy wrote with comments (JSONC) is replaced.
AGY_NODE=$(command -v node) sudo -n -u agent -H --preserve-env=AGY_NODE,AGY_BRIDGE node -e '
const fs = require("node:fs")
const home = process.env.HOME
const merge = (file, change) => {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  fs.writeFileSync(file, JSON.stringify(change(current), null, 2) + "\n", { mode: 0o600 })
}
merge(home + "/.gemini/config/mcp_config.json", (c) => ({
  ...c,
  mcpServers: {
    ...c.mcpServers,
    milibot: { command: process.env.AGY_NODE, args: [process.env.AGY_BRIDGE], timeoutSeconds: 3600 },
  },
}))
fs.mkdirSync(home + "/.gemini/antigravity-cli", { recursive: true, mode: 0o700 })
merge(home + "/.gemini/antigravity-cli/settings.json", (s) => ({
  ...s,
  trustedWorkspaces: [...new Set([...(s.trustedWorkspaces || []), "/workspace"])],
}))
'
"$real" --version
sha256sum "$AGY_BRIDGE"
