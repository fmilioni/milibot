#!/bin/bash
# Logs gh in with the token on stdin (never argv/env: it would leak through ps or the guest agent logs) and
# makes git use it, also for SSH GitHub URLs (the VM has no SSH key); MILIBOT_GH=logout logs out, keep leaves
# the login alone. Sets the commit identity when GIT_NAME is given.
set -e
if [ "$MILIBOT_GH" = "login" ]; then
  gh auth login --hostname github.com --git-protocol https --with-token
  gh auth setup-git --hostname github.com
  git config --global --unset-all url.https://github.com/.insteadOf || true
  git config --global --add url.https://github.com/.insteadOf git@github.com:
  git config --global --add url.https://github.com/.insteadOf ssh://git@github.com/
elif [ "$MILIBOT_GH" = "logout" ]; then
  gh auth logout --hostname github.com >/dev/null 2>&1 || true
  git config --global --unset-all url.https://github.com/.insteadOf || true
fi
if [ -n "$GIT_NAME" ]; then
  git config --global user.name "$GIT_NAME"
  git config --global user.email "$GIT_EMAIL"
fi
