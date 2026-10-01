#!/bin/bash
# The first Chrome/Chromium installed, headless, with its DevTools port on loopback.
# Env: RENDER_PORT, RENDER_PROFILE.
for b in google-chrome-stable chromium google-chrome chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    exec "$b" --headless=new --remote-debugging-port="$RENDER_PORT" --remote-debugging-address=127.0.0.1 \
      --user-data-dir="$RENDER_PROFILE" --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage \
      --disable-extensions --hide-scrollbars --mute-audio --force-color-profile=srgb --font-render-hinting=none \
      about:blank
  fi
done
echo "no browser installed" >&2
exit 127
