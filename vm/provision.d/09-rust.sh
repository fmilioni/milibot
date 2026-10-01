# shellcheck shell=bash
install -d -o agent -g workspace -m 2775 /opt/rust
if [ ! -x /opt/rust/cargo/bin/rustup ]; then
  RUST_TRIPLE=$([ "$ARCH" = arm64 ] && echo aarch64 || echo x86_64)-unknown-linux-gnu
  fetch_verified "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$RUST_TRIPLE/rustup-init" \
    /tmp/rustup-init "$(pinned RUSTUP_SHA256)"
  chmod 0755 /tmp/rustup-init
  runuser -u agent -- env RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo HOME=/home/agent \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable -c rustfmt -c clippy
  rm -f /tmp/rustup-init
else
  runuser -u agent -- env RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo HOME=/home/agent \
    /opt/rust/cargo/bin/rustup update stable
fi
chgrp -R workspace /opt/rust
chmod -R g+w /opt/rust
find /opt/rust -type d -exec chmod g+s {} +
