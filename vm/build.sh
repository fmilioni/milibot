#!/bin/bash
# Manual shortcut for `node vm/host/src/cli/build-golden.ts` (same options; see --help).
set -euo pipefail
VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$VM_DIR/host/src/cli/build-golden.ts" "$@"
