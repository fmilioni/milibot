# shellcheck shell=bash
if [ "$(/usr/local/bin/uv --version 2>/dev/null | awk '{print $2}')" != "$UV_VERSION" ]; then
  UV_TRIPLE=$([ "$ARCH" = arm64 ] && echo aarch64 || echo x86_64)-unknown-linux-gnu
  fetch_verified "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TRIPLE.tar.gz" \
    /tmp/uv.tgz "$(pinned UV_SHA256)"
  tar -C /tmp -xzf /tmp/uv.tgz
  install -m 0755 "/tmp/uv-$UV_TRIPLE/uv" "/tmp/uv-$UV_TRIPLE/uvx" /usr/local/bin/
  rm -rf /tmp/uv.tgz "/tmp/uv-$UV_TRIPLE"
fi
