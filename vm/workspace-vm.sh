#!/bin/bash
# Manual shortcut for `node vm/host/src/cli/workspace-vm.ts` (see `help`); JSON on stdout.
set -euo pipefail
VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
exec node "$VM_DIR/host/src/cli/workspace-vm.ts" "$@"
