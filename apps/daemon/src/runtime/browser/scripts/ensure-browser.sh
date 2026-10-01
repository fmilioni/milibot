#!/bin/bash
set -u
launcher=/usr/local/bin/milibot-browser
user="bot-$SLUG"
home="/home/$user"
ready() { curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
if ready; then echo STATE=ready; exit 0; fi
id "$user" >/dev/null 2>&1 || { echo "STATE=no_user"; exit 3; }
profile="$home/.config/milibot-browser"
main=""
for p in $(pgrep -u "$user" -f -- "--user-data-dir=$profile" 2>/dev/null); do
  if ! tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | grep -q '^--type='; then main=$p; break; fi
done
restore=""
if [ -n "$main" ]; then
  kill -TERM "$main" 2>/dev/null
  for _ in $(seq 1 150); do kill -0 "$main" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$main" 2>/dev/null; then echo "STATE=still_running"; exit 4; fi
  restore="--restore-last-session"
  echo RESTARTED=1
fi
slice="milibot-bot-$(printf '%s' "$SLUG" | sed 's/-/\\x2d/g').slice"
systemd-run --quiet --collect --unit="milibot-browser-$SLUG-$(date +%s%N)" --slice="$slice" \
  --uid="$user" --gid="$user" --working-directory="$home" \
  --setenv=DISPLAY=":$DISPLAY_NUM" --setenv=XAUTHORITY="$home/.Xauthority" \
  --setenv=XDG_RUNTIME_DIR="/run/milibot-desktop-$SLUG" \
  "$launcher" ${restore:+"$restore"} >/dev/null 2>&1 || { echo "STATE=launch_failed"; exit 5; }
for _ in $(seq 1 200); do
  if ready; then echo STATE=started; exit 0; fi
  sleep 0.1
done
echo "STATE=timeout"
exit 6
