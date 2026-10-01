#!/bin/bash
# Provisions a Debian 13 (arm64 or amd64) guest into the Milibot golden image. Idempotent: safe to re-run inside a live VM.
# Runs as root from the extracted payload (provision.sh, provision.d/, versions.env, guest/, guest-agent.mjs); the
# steps in provision.d/ are sourced in order and each one is announced as `[provision step <i>/<n> <name>]`.
# shellcheck disable=SC2034 # the constants are read by the sourced provision.d steps
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

AGENT_UID=1500
WORKSPACE_GID=1450
DOCKER_GID=1451
ARCH=$(dpkg --print-architecture)

# shellcheck source-path=SCRIPTDIR source=versions.env
. "$SRC_DIR/versions.env"

log() { echo "[provision $(date -u +%H:%M:%S)] $*"; }

apt_get() {
  apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

apt_install() { apt_get install --no-install-recommends "$@"; }

retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    [ $n -ge 4 ] && return 1
    log "retry $n: $*"
    sleep $((n * 5))
  done
}

add_repo() {
  local name=$1 key_url=$2 line=$3
  install -d -m 0755 /etc/apt/keyrings
  retry curl -fsSL "$key_url" -o "/tmp/$name.key"
  if grep -q "BEGIN PGP" "/tmp/$name.key"; then
    gpg --dearmor --yes -o "/etc/apt/keyrings/$name.gpg" "/tmp/$name.key"
  else
    install -m 0644 "/tmp/$name.key" "/etc/apt/keyrings/$name.gpg"
  fi
  chmod 0644 "/etc/apt/keyrings/$name.gpg"
  echo "$line" > "/etc/apt/sources.list.d/$name.list"
}

# The value of `<NAME>_<ARCH>` from versions.env (e.g. `pinned GO_SHA256`).
pinned() {
  local var
  var="${1}_$(tr '[:lower:]' '[:upper:]' <<<"$ARCH")"
  printf '%s' "${!var:?no $var in versions.env}"
}

sha256_matches() { echo "$2  $1" | sha256sum -c --status - 2>/dev/null; }

fetch_verified() {
  local url=$1 dest=$2 sha=$3
  retry curl -fsSL "$url" -o "$dest"
  if ! sha256_matches "$dest" "$sha"; then
    rm -f "$dest"
    echo "checksum mismatch for $url" >&2
    return 1
  fi
}

steps=("$SRC_DIR"/provision.d/*.sh)
for i in "${!steps[@]}"; do
  name=$(basename "${steps[$i]}" .sh)
  echo "[provision step $((i + 1))/${#steps[@]} ${name#[0-9]*-}]"
  # shellcheck source=/dev/null
  . "${steps[$i]}"
done

log "done"
