# shellcheck shell=bash
if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go$GO_VERSION" ]; then
  fetch_verified "https://go.dev/dl/go$GO_VERSION.linux-$ARCH.tar.gz" /tmp/go.tgz "$(pinned GO_SHA256)"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
fi
