#!/bin/bash
# Creates the VM's SSH key once (comment $KEY_COMMENT) and prints its public key.
set -e
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "$KEY_COMMENT" -f "$HOME/.ssh/id_ed25519"
cat "$HOME/.ssh/id_ed25519.pub"
