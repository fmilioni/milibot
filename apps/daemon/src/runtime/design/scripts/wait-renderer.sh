#!/bin/bash
# Waits up to 20 s for the renderer's DevTools endpoint. Env: RENDER_PORT.
for _ in $(seq 1 200); do
  curl -fsS -m 1 "http://127.0.0.1:$RENDER_PORT/json/version" >/dev/null 2>&1 && exit 0
  sleep 0.1
done
exit 1
