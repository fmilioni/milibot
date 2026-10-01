#!/bin/bash
# Frees the port from a renderer an older runtime left behind; the bracket keeps pkill off this shell.
# Env: RENDER_PROFILE.
pkill -f -- "--user-data-dir=${RENDER_PROFILE%?}[${RENDER_PROFILE: -1}]" || true
sleep 0.3
