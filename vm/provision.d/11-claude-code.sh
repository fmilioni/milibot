# shellcheck shell=bash
# /usr/local/bin/claude is a wrapper that switches any other user to agent, where the bots' login lives.
CLAUDE_REAL=/usr/local/lib/milibot/claude-real
CLAUDE_SHA=$(pinned CLAUDE_CODE_SHA256)
install -d -m 0755 /usr/local/lib/milibot
if ! sha256_matches "$CLAUDE_REAL" "$CLAUDE_SHA"; then
  fetch_verified \
    "https://downloads.claude.ai/claude-code-releases/$CLAUDE_CODE_VERSION/linux-$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)/claude" \
    /tmp/claude "$CLAUDE_SHA"
  install -m 0755 /tmp/claude "$CLAUDE_REAL.new"
  mv -f "$CLAUDE_REAL.new" "$CLAUDE_REAL"
  rm -f /tmp/claude
fi
install -m 0755 "$SRC_DIR"/guest/bin/cli-wrapper /usr/local/bin/claude.new
mv -f /usr/local/bin/claude.new /usr/local/bin/claude
rm -rf /home/agent/.local/bin/claude /home/agent/.local/share/claude /home/agent/.claude /home/agent/.claude.json \
  /home/agent/.cache/claude /home/agent/.local/state/claude
