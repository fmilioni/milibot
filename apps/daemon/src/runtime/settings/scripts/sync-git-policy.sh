#!/bin/bash
# Runs as root with the policy in $POLICY: writes /etc/milibot/git-policy (read by the gh wrapper) when it
# changed.
set -u
install -d -m 0755 /etc/milibot
file=$(mktemp)
printf '%s' "$POLICY" > "$file"
if ! cmp -s "$file" /etc/milibot/git-policy; then install -m 0644 "$file" /etc/milibot/git-policy && echo POLICY=updated; fi
rm -f "$file"
