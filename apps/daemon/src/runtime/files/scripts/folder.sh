#!/bin/bash
# Makes the folder of a session without a repository (SESSION_DIR) and prints where it really is, relative to
# WORKSPACE_ROOT (`REL=`), or `OUTSIDE=1` when a symlink takes it out of /workspace.
set -u
mkdir -p "$SESSION_DIR" || exit 1
real=$(cd "$SESSION_DIR" && pwd -P) || exit 1
root=$(cd "$WORKSPACE_ROOT" && pwd -P) || exit 1
case "$real" in
  "$root"/?*) echo "REL=${real#"$root"/}" ;;
  *) echo "OUTSIDE=1" ;;
esac
